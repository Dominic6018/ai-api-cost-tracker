import "dotenv/config";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { parseEnv } from "@/lib/env";
import { COMMAND_LINE, type AuditActor } from "./audit";
import {
  addAdjustment,
  createBillingCustomer,
  findBillingCustomer,
  listBillingCustomers,
  listLedgerEntries,
  reverseLedgerEntry,
} from "./billing";
import {
  auditLog,
  billingCustomers,
  billingLedgerEntries,
  organizations,
} from "./schema";

// Runs against the database in DATABASE_URL after `npm run db:migrate`.
// More than one connection, so concurrent reversals really overlap.
const client = postgres(parseEnv().DATABASE_URL, {
  max: 4,
  onnotice: () => {},
});
const db = drizzle(client);

const organizationIds: string[] = [];

afterAll(async () => {
  if (organizationIds.length > 0) {
    await db
      .delete(auditLog)
      .where(inArray(auditLog.organizationId, organizationIds));
    // Deleting an organization removes its ledger, the one delete the
    // append-only trigger allows.
    await db
      .delete(organizations)
      .where(inArray(organizations.id, organizationIds));
    const [left] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(billingLedgerEntries)
      .where(inArray(billingLedgerEntries.organizationId, organizationIds));
    expect(left.n).toBe(0);
  }
  await client.end();
});

async function newOrganization() {
  const [organization] = await db
    .insert(organizations)
    .values({ name: "Billing test", slug: `it-${randomUUID()}` })
    .returning();
  organizationIds.push(organization.id);
  const actor: AuditActor = {
    ...COMMAND_LINE,
    organizationId: organization.id,
  };
  return { organization, scope: { organizationId: organization.id }, actor };
}

async function newCustomer(externalId = "cus_42") {
  const org = await newOrganization();
  const created = await createBillingCustomer(db, org.actor, {
    ...org.scope,
    externalId,
    name: "Acme",
  });
  if (!created.ok) throw new Error("customer not created");
  return { ...org, customer: created.customer };
}

const audited = (organizationId: string) =>
  db
    .select({ action: auditLog.action, target: auditLog.target })
    .from(auditLog)
    .where(eq(auditLog.organizationId, organizationId))
    .orderBy(auditLog.occurredAt, auditLog.id);

describe("billing customers", () => {
  it("adds a customer once per organization, with an audit entry", async () => {
    const { organization, scope, actor, customer } = await newCustomer();
    expect(customer).toMatchObject({ externalId: "cus_42", name: "Acme" });

    const again = await createBillingCustomer(db, actor, {
      ...scope,
      externalId: "cus_42",
      name: "Other",
    });
    expect(again).toEqual({ ok: false, error: "external_id_taken" });
    expect(await audited(organization.id)).toEqual([
      { action: "billing.customer_created", target: "cus_42" },
    ]);

    // Another organization can use the same customer ID.
    const other = await newCustomer("cus_42");
    expect(other.customer.id).not.toBe(customer.id);
    expect((await findBillingCustomer(db, scope, "cus_42"))?.id).toBe(
      customer.id,
    );
    expect((await findBillingCustomer(db, other.scope, "cus_42"))?.id).toBe(
      other.customer.id,
    );
  });

  it("lists only the organization's customers, with balances", async () => {
    const { scope, actor, customer } = await newCustomer();
    const other = await newCustomer();
    await addAdjustment(db, actor, customer, {
      amountMicros: 10_000_000n,
      description: "Setup fee",
    });
    await addAdjustment(db, other.actor, other.customer, {
      amountMicros: 99_000_000n,
      description: "Elsewhere",
    });

    const rows = await listBillingCustomers(db, scope);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      customer: { id: customer.id },
      balanceMicros: 10_000_000n,
      entries: 1,
    });
  });
});

describe("adjustments", () => {
  it("records charges and credits exactly, and sums them", async () => {
    const { organization, scope, actor, customer } = await newCustomer();
    const charge = await addAdjustment(db, actor, customer, {
      amountMicros: 12_345_678n,
      description: "Onboarding",
    });
    const credit = await addAdjustment(db, actor, customer, {
      amountMicros: -2_000_001n,
      description: "Goodwill credit",
    });
    expect(charge).toMatchObject({
      ok: true,
      replayed: false,
      entry: {
        kind: "adjustment",
        amountUsd: "12.345678",
        createdBy: "command line",
      },
    });
    expect(credit).toMatchObject({
      ok: true,
      entry: { amountUsd: "-2.000001" },
    });

    const [row] = await listBillingCustomers(db, scope);
    expect(row.balanceMicros).toBe(10_345_677n);
    const entries = await listLedgerEntries(db, customer);
    expect(entries.map((e) => e.description).sort()).toEqual([
      "Goodwill credit",
      "Onboarding",
    ]);
    expect(await audited(organization.id)).toEqual([
      { action: "billing.customer_created", target: "cus_42" },
      { action: "billing.adjusted", target: "cus_42" },
      { action: "billing.adjusted", target: "cus_42" },
    ]);
  });

  it("replays a retry with the same key, and refuses the key for anything else", async () => {
    const { organization, actor, customer } = await newCustomer();
    const input = {
      amountMicros: 5_000_000n,
      description: "Annual support",
      entryKey: "inv-2026-11",
    };
    const first = await addAdjustment(db, actor, customer, input);
    const retry = await addAdjustment(db, actor, customer, input);
    if (!first.ok || !retry.ok) throw new Error("expected entries");
    expect(retry.replayed).toBe(true);
    expect(retry.entry.id).toBe(first.entry.id);

    for (const different of [
      { ...input, amountMicros: 5_000_001n },
      { ...input, description: "Something else" },
    ]) {
      expect(await addAdjustment(db, actor, customer, different)).toEqual({
        ok: false,
        error: "entry_key_conflict",
      });
    }
    // Only the first was stored, and audited.
    expect(await listLedgerEntries(db, customer)).toHaveLength(1);
    expect(
      (await audited(organization.id)).filter(
        (e) => e.action === "billing.adjusted",
      ),
    ).toHaveLength(1);
  });
});

describe("reversals", () => {
  it("cancels an entry once, keeping the original", async () => {
    const { scope, actor, customer } = await newCustomer();
    const charge = await addAdjustment(db, actor, customer, {
      amountMicros: 7_250_000n,
      description: "Charged twice",
    });
    if (!charge.ok) throw new Error("expected an entry");

    const reversal = await reverseLedgerEntry(db, actor, scope, {
      entryId: charge.entry.id,
      description: "Duplicate charge",
    });
    expect(reversal).toMatchObject({
      ok: true,
      entry: {
        kind: "reversal",
        amountUsd: "-7.250000",
        reversesEntryId: charge.entry.id,
        customerId: customer.id,
      },
    });
    if (!reversal.ok) throw new Error("expected a reversal");

    expect(
      await reverseLedgerEntry(db, actor, scope, {
        entryId: charge.entry.id,
        description: "Again",
      }),
    ).toEqual({ ok: false, error: "already_reversed" });
    expect(
      await reverseLedgerEntry(db, actor, scope, {
        entryId: reversal.entry.id,
        description: "Undo the undo",
      }),
    ).toEqual({ ok: false, error: "is_reversal" });

    const [row] = await listBillingCustomers(db, scope);
    expect(row).toMatchObject({ balanceMicros: 0n, entries: 2 });
  });

  it("can't reach another organization's entries", async () => {
    const { actor, customer } = await newCustomer();
    const other = await newOrganization();
    const charge = await addAdjustment(db, actor, customer, {
      amountMicros: 1_000_000n,
      description: "Mine",
    });
    if (!charge.ok) throw new Error("expected an entry");
    for (const entryId of [charge.entry.id, "not-a-uuid", randomUUID()]) {
      expect(
        await reverseLedgerEntry(db, other.actor, other.scope, {
          entryId,
          description: "Not yours",
        }),
      ).toEqual({ ok: false, error: "not_found" });
    }
  });

  it("lets only one of two concurrent reversals through", async () => {
    const { scope, actor, customer } = await newCustomer();
    const charge = await addAdjustment(db, actor, customer, {
      amountMicros: 3_000_000n,
      description: "Race",
    });
    if (!charge.ok) throw new Error("expected an entry");
    const results = await Promise.all(
      [1, 2, 3].map(() =>
        reverseLedgerEntry(db, actor, scope, {
          entryId: charge.entry.id,
          description: "Concurrent",
        }),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([
      { ok: false, error: "already_reversed" },
      { ok: false, error: "already_reversed" },
    ]);
    const [row] = await listBillingCustomers(db, scope);
    expect(row.balanceMicros).toBe(0n);
  });
});

describe("the ledger is append-only", () => {
  it("refuses updates, deletes and truncation", async () => {
    const { actor, customer } = await newCustomer();
    const charge = await addAdjustment(db, actor, customer, {
      amountMicros: 1_000_000n,
      description: "Fixed",
    });
    if (!charge.ok) throw new Error("expected an entry");
    const byId = eq(billingLedgerEntries.id, charge.entry.id);

    await expect(
      db.update(billingLedgerEntries).set({ amountUsd: "0.01" }).where(byId),
    ).rejects.toThrow();
    await expect(db.delete(billingLedgerEntries).where(byId)).rejects.toThrow();
    await expect(
      db.execute(sql`TRUNCATE billing_ledger_entries`),
    ).rejects.toThrow();
    // A customer with entries can't be deleted either.
    await expect(
      db.delete(billingCustomers).where(eq(billingCustomers.id, customer.id)),
    ).rejects.toThrow();

    const [stored] = await db.select().from(billingLedgerEntries).where(byId);
    expect(stored.amountUsd).toBe("1.000000");
  });

  it("keeps an entry's customer in the entry's organization", async () => {
    const { customer } = await newCustomer();
    const other = await newOrganization();
    await expect(
      db.insert(billingLedgerEntries).values({
        organizationId: other.organization.id,
        customerId: customer.id,
        kind: "adjustment",
        amountUsd: "1",
        description: "Cross-organization",
        createdBy: "test",
      }),
    ).rejects.toThrow();
  });

  it("refuses zero amounts and reversals without an original", async () => {
    const { organization, customer } = await newCustomer();
    const base = {
      organizationId: organization.id,
      customerId: customer.id,
      description: "Invalid",
      createdBy: "test",
    };
    await expect(
      db
        .insert(billingLedgerEntries)
        .values({ ...base, kind: "adjustment", amountUsd: "0" }),
    ).rejects.toThrow();
    await expect(
      db
        .insert(billingLedgerEntries)
        .values({ ...base, kind: "reversal", amountUsd: "-1" }),
    ).rejects.toThrow();
    const stored = await db
      .select()
      .from(billingLedgerEntries)
      .where(
        and(
          eq(billingLedgerEntries.organizationId, organization.id),
          eq(billingLedgerEntries.description, "Invalid"),
        ),
      );
    expect(stored).toEqual([]);
  });
});
