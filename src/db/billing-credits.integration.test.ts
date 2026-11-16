import "dotenv/config";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { parseEnv } from "@/lib/env";
import { COMMAND_LINE, type AuditActor } from "./audit";
import {
  addAdjustment,
  createBillingCustomer,
  listBillingCustomers,
  reverseLedgerEntry,
} from "./billing";
import {
  applyCredits,
  grantCredit,
  listCreditGrants,
  refundCredit,
  usableCredit,
} from "./billing-credits";
import {
  auditLog,
  billingCreditGrants,
  billingCreditUses,
  organizations,
} from "./schema";

// Runs against the database in DATABASE_URL after `npm run db:migrate`.
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
    // Removes credit, the one delete their triggers allow.
    await db
      .delete(organizations)
      .where(inArray(organizations.id, organizationIds));
  }
  await client.end();
});

const DAY = 86_400_000;
const later = (days: number) => new Date(Date.now() + days * DAY);

async function setup() {
  const [organization] = await db
    .insert(organizations)
    .values({ name: "Credits test", slug: `it-${randomUUID()}` })
    .returning();
  organizationIds.push(organization.id);
  const scope = { organizationId: organization.id };
  const actor: AuditActor = {
    ...COMMAND_LINE,
    organizationId: organization.id,
  };
  const created = await createBillingCustomer(db, actor, {
    ...scope,
    externalId: "cus_42",
    name: "Acme",
  });
  if (!created.ok) throw new Error("customer not created");
  const customer = created.customer;
  const owe = (amountMicros: bigint) =>
    addAdjustment(db, actor, customer, {
      amountMicros,
      description: "Charge",
    });
  const grant = async (amountMicros: bigint, expiresAt: Date | null = null) => {
    const result = await grantCredit(db, actor, customer, {
      amountMicros,
      expiresAt,
      description: "Prepaid",
    });
    if (!result.ok) throw new Error(result.error);
    return result.grant;
  };
  const balance = async () =>
    (await listBillingCustomers(db, scope))[0].balanceMicros;
  return { organization, scope, actor, customer, owe, grant, balance };
}

describe("granting credit", () => {
  it("grants once per key, and refuses a past expiry", async () => {
    const t = await setup();
    const input = {
      amountMicros: 25_000_000n,
      expiresAt: later(30),
      description: "Annual prepayment",
      grantKey: "inv-7",
    };
    const first = await grantCredit(db, t.actor, t.customer, input);
    const retry = await grantCredit(db, t.actor, t.customer, input);
    if (!first.ok || !retry.ok) throw new Error("expected grants");
    expect(retry).toMatchObject({
      replayed: true,
      grant: { id: first.grant.id },
    });
    expect(
      await grantCredit(db, t.actor, t.customer, {
        ...input,
        amountMicros: 1n,
      }),
    ).toEqual({ ok: false, error: "grant_key_conflict" });
    expect(
      await grantCredit(db, t.actor, t.customer, {
        ...input,
        grantKey: undefined,
        expiresAt: later(-1),
      }),
    ).toEqual({ ok: false, error: "already_expired" });
    expect(usableCredit(await listCreditGrants(db, t.customer))).toBe(
      25_000_000n,
    );
    // Granting credit doesn't change what's owed until it's applied.
    expect(await t.balance()).toBe(0n);
  });
});

describe("applying credit", () => {
  it("pays what's owed, soonest-expiring first, and only once", async () => {
    const t = await setup();
    await t.owe(30_000_000n);
    const open = await t.grant(20_000_000n);
    const soon = await t.grant(15_000_000n, later(10));

    const result = await applyCredits(db, t.actor, t.customer);
    expect(result.appliedMicros).toBe(30_000_000n);
    expect(result.entry).toMatchObject({
      kind: "credit_applied",
      amountUsd: "-30.000000",
    });
    expect(await t.balance()).toBe(0n);
    const grants = await listCreditGrants(db, t.customer);
    const left = Object.fromEntries(
      grants.map((g) => [g.grant.id, g.remainingMicros]),
    );
    expect(left[soon.id]).toBe(0n);
    expect(left[open.id]).toBe(5_000_000n);

    // Nothing owed now, so nothing more is applied.
    expect((await applyCredits(db, t.actor, t.customer)).appliedMicros).toBe(
      0n,
    );
    const audited = await db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.organizationId, t.organization.id),
          eq(auditLog.action, "billing.credits_applied"),
        ),
      );
    expect(audited).toHaveLength(1);
  });

  it("applies only what credit there is, and never expired credit", async () => {
    const t = await setup();
    await t.owe(50_000_000n);
    await t.grant(8_000_000n);
    // Expired credit, written as if granted last month.
    await db.insert(billingCreditGrants).values({
      organizationId: t.organization.id,
      customerId: t.customer.id,
      amountUsd: "100",
      createdAt: later(-40),
      expiresAt: later(-10),
      description: "Expired",
      createdBy: "test",
    });
    const result = await applyCredits(db, t.actor, t.customer);
    expect(result.appliedMicros).toBe(8_000_000n);
    expect(await t.balance()).toBe(42_000_000n);
    const grants = await listCreditGrants(db, t.customer);
    expect(grants.find((g) => g.expired)?.remainingMicros).toBe(100_000_000n);
    expect(usableCredit(grants)).toBe(0n);
  });

  it("never uses credit twice when applied at the same moment", async () => {
    const t = await setup();
    await t.owe(10_000_000n);
    await t.grant(100_000_000n);
    const results = await Promise.all(
      [1, 2, 3].map(() => applyCredits(db, t.actor, t.customer)),
    );
    expect(
      results.map((r) => r.appliedMicros).sort((a, b) => Number(b - a)),
    ).toEqual([10_000_000n, 0n, 0n]);
    expect(await t.balance()).toBe(0n);
  });

  it("can't be reversed", async () => {
    const t = await setup();
    await t.owe(5_000_000n);
    await t.grant(5_000_000n);
    const { entry } = await applyCredits(db, t.actor, t.customer);
    expect(
      await reverseLedgerEntry(db, t.actor, t.scope, {
        entryId: entry!.id,
        description: "Undo",
      }),
    ).toEqual({ ok: false, error: "is_credit" });
  });
});

describe("refunding credit", () => {
  it("withdraws what's left, once, and not expired credit", async () => {
    const t = await setup();
    await t.owe(4_000_000n);
    const grant = await t.grant(10_000_000n);
    await applyCredits(db, t.actor, t.customer);

    expect(
      await refundCredit(db, t.actor, t.scope, {
        grantId: grant.id,
        reason: "Cancelled",
      }),
    ).toEqual({
      ok: true,
      refundedMicros: 6_000_000n,
      customerExternalId: "cus_42",
    });
    expect(
      await refundCredit(db, t.actor, t.scope, {
        grantId: grant.id,
        reason: "Again",
      }),
    ).toEqual({ ok: false, error: "nothing_left" });
    expect(usableCredit(await listCreditGrants(db, t.customer))).toBe(0n);
    // What was applied stays applied.
    expect(await t.balance()).toBe(0n);

    const other = await setup();
    for (const grantId of [grant.id, "not-a-uuid", randomUUID()]) {
      expect(
        await refundCredit(db, other.actor, other.scope, {
          grantId,
          reason: "Not yours",
        }),
      ).toEqual({ ok: false, error: "not_found" });
    }
  });
});

describe("the database guards credit", () => {
  it("refuses overspending a grant, using expired credit, and changes", async () => {
    const t = await setup();
    const grant = await t.grant(10_000_000n);
    const use = (amountUsd: string, grantId = grant.id) =>
      db.insert(billingCreditUses).values({
        organizationId: t.organization.id,
        customerId: t.customer.id,
        grantId,
        kind: "refunded",
        amountUsd,
        createdBy: "test",
      });
    await use("9.999999");
    await expect(use("0.000002")).rejects.toThrow();
    await use("0.000001");
    await expect(use("0.000001")).rejects.toThrow();

    const [expired] = await db
      .insert(billingCreditGrants)
      .values({
        organizationId: t.organization.id,
        customerId: t.customer.id,
        amountUsd: "5",
        createdAt: later(-2),
        expiresAt: later(-1),
        description: "Expired",
        createdBy: "test",
      })
      .returning();
    await expect(use("1", expired.id)).rejects.toThrow();

    await expect(
      db
        .update(billingCreditGrants)
        .set({ amountUsd: "1000" })
        .where(eq(billingCreditGrants.id, grant.id)),
    ).rejects.toThrow();
    await expect(
      db
        .delete(billingCreditUses)
        .where(eq(billingCreditUses.grantId, grant.id)),
    ).rejects.toThrow();
    // Another customer's grant can't be used for this one.
    const other = await setup();
    const foreign = await other.grant(1_000_000n);
    await expect(use("1", foreign.id)).rejects.toThrow();
  });
});
