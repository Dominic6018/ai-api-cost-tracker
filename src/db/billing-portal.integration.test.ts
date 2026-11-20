import "dotenv/config";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { monthStart } from "@/lib/billing";
import { parseEnv } from "@/lib/env";
import { PORTAL_LINK_TTL_MS } from "@/lib/portal";
import { COMMAND_LINE, type AuditActor } from "./audit";
import { addAdjustment, createBillingCustomer } from "./billing";
import { grantCredit } from "./billing-credits";
import { changePlan, createBillingPlan } from "./billing-plans";
import {
  createPortalLink,
  findCustomerById,
  getStatement,
  listPortalLinks,
  openPortal,
  revokePortalLink,
} from "./billing-portal";
import {
  auditLog,
  billingLedgerEntries,
  billingPortalLinks,
  organizations,
  type BillingCustomer,
} from "./schema";

// Runs against the database in DATABASE_URL after `npm run db:migrate`.
const client = postgres(parseEnv().DATABASE_URL, {
  max: 1,
  onnotice: () => {},
});
const db = drizzle(client);

const organizationIds: string[] = [];
let customer: BillingCustomer;
let other: BillingCustomer;

async function setup(label: string, externalId: string) {
  const [organization] = await db
    .insert(organizations)
    .values({ name: `Portal ${label}`, slug: `it-portal-${randomUUID()}` })
    .returning();
  organizationIds.push(organization.id);
  const actor: AuditActor = {
    ...COMMAND_LINE,
    organizationId: organization.id,
  };
  const created = await createBillingCustomer(db, actor, {
    organizationId: organization.id,
    externalId,
    name: `${label} customer`,
  });
  if (!created.ok) throw new Error("customer not created");
  return { actor, customer: created.customer };
}

beforeAll(async () => {
  const ours = await setup("ours", "cus_portal");
  customer = ours.customer;
  other = (await setup("theirs", "cus_other")).customer;

  // $40 plan fee, a $12.345678 usage charge, a $10 payment, $5 of credit.
  const plan = await createBillingPlan(db, ours.actor, {
    organizationId: customer.organizationId,
    slug: "team",
    name: "Team",
    monthlyFeeMicros: 40_000_000n,
    includedUsageMicros: 20_000_000n,
    usageMultiplier: "1.7500",
  });
  if (!plan.ok) throw new Error("plan not created");
  const now = new Date();
  const changed = await changePlan(
    db,
    ours.actor,
    customer,
    plan.plan,
    monthStart(now),
    now,
  );
  if (!changed.ok) throw new Error("plan not set");
  for (const [amountMicros, description] of [
    [40_000_000n, "Team plan, this month"],
    [12_345_678n, "Usage above the plan"],
    [-10_000_000n, "Goodwill credit"],
  ] as const) {
    await addAdjustment(db, ours.actor, customer, {
      amountMicros,
      description,
    });
  }
  const credit = await grantCredit(db, ours.actor, customer, {
    amountMicros: 5_000_000n,
    expiresAt: new Date(Date.now() + 30 * 86_400_000),
    description: "Prepaid",
  });
  if (!credit.ok) throw new Error("credit not granted");
  // A usage charge as charge writes it, naming the AI API cost.
  await db.insert(billingLedgerEntries).values({
    organizationId: customer.organizationId,
    customerId: customer.id,
    kind: "usage_charge",
    amountUsd: "7.500000",
    usageCostUsd: "6.000000",
    planId: plan.plan.id,
    period: "2026-10-01",
    description:
      "Usage, 2026-10: $6.000000 AI API cost x 1.7500 = $10.500000, less $3.000000 included",
    createdBy: "command line",
  });
});

afterAll(async () => {
  await db
    .delete(auditLog)
    .where(inArray(auditLog.organizationId, organizationIds));
  // Cascades to customers, their ledgers and portal links.
  await db
    .delete(organizations)
    .where(inArray(organizations.id, organizationIds));
  await client.end();
});

describe("portal links", () => {
  it("stores only the link's hash, for 90 days", async () => {
    const now = new Date("2026-11-21T09:00:00Z");
    const { token, link } = await createPortalLink(
      db,
      { customer, createdBy: "admin@example.com" },
      now,
    );
    expect(link).toMatchObject({
      customerId: customer.id,
      organizationId: customer.organizationId,
      createdBy: "admin@example.com",
      customer: { externalId: "cus_portal", name: "ours customer" },
    });
    expect(link.expiresAt.getTime()).toBe(now.getTime() + PORTAL_LINK_TTL_MS);
    const [stored] = await db
      .select()
      .from(billingPortalLinks)
      .where(eq(billingPortalLinks.id, link.id));
    expect(Object.values(stored)).not.toContain(token);
    expect(stored.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("can't point at another organization's customer", async () => {
    await expect(
      db.insert(billingPortalLinks).values({
        organizationId: customer.organizationId,
        customerId: other.id,
        tokenHash: "f".repeat(64),
        createdBy: "test",
        expiresAt: new Date(Date.now() + 1000),
      }),
    ).rejects.toThrow();
    expect(
      await findCustomerById(db, customer.organizationId, other.id),
    ).toBeUndefined();
    expect(
      await findCustomerById(db, customer.organizationId, "nope"),
    ).toBeUndefined();
  });

  it("opens one customer's portal while working, recording the view", async () => {
    const { token, link } = await createPortalLink(db, {
      customer,
      createdBy: "admin@example.com",
    });
    const at = new Date();
    const opened = await openPortal(db, token, at);
    expect(opened?.customer.id).toBe(customer.id);
    expect(opened?.organizationName).toBe("Portal ours");
    const [stored] = await db
      .select()
      .from(billingPortalLinks)
      .where(eq(billingPortalLinks.id, link.id));
    expect(stored.lastViewedAt?.toISOString()).toBe(at.toISOString());

    for (const bad of ["not-a-token", "A".repeat(43)]) {
      expect(await openPortal(db, bad)).toBeNull();
    }
    // Past its 90 days.
    expect(
      await openPortal(
        db,
        token,
        new Date(Date.now() + PORTAL_LINK_TTL_MS + 1),
      ),
    ).toBeNull();
  });

  it("lists and revokes only the organization's working links", async () => {
    const mine = await createPortalLink(db, { customer, createdBy: "a" });
    const theirs = await createPortalLink(db, {
      customer: other,
      createdBy: "b",
    });

    const listed = await listPortalLinks(db, customer.organizationId);
    expect(listed.map((l) => l.id)).toContain(mine.link.id);
    expect(listed.map((l) => l.id)).not.toContain(theirs.link.id);
    for (const row of listed) expect(row).not.toHaveProperty("tokenHash");

    expect(
      await revokePortalLink(db, {
        organizationId: customer.organizationId,
        linkId: theirs.link.id,
      }),
    ).toBeNull();
    expect(await openPortal(db, theirs.token)).not.toBeNull();

    const revoked = await revokePortalLink(db, {
      organizationId: customer.organizationId,
      linkId: mine.link.id,
    });
    expect(revoked).toMatchObject({
      id: mine.link.id,
      customer: { externalId: "cus_portal" },
    });
    expect(await openPortal(db, mine.token)).toBeNull();
    expect(
      (await listPortalLinks(db, customer.organizationId)).map((l) => l.id),
    ).not.toContain(mine.link.id);
    expect(
      await revokePortalLink(db, {
        organizationId: customer.organizationId,
        linkId: mine.link.id,
      }),
    ).toBeNull();
  });
});

describe("getStatement", () => {
  it("shows what the customer is billed, and nothing about cost", async () => {
    const statement = await getStatement(db, customer);
    expect(statement.balanceMicros).toBe(49_845_678n);
    expect(
      statement.entries.map((e) => [e.description, e.amountMicros]),
    ).toEqual([
      // Named by its month, not by the description that holds its cost.
      ["Usage, 2026-10", 7_500_000n],
      ["Goodwill credit", -10_000_000n],
      ["Usage above the plan", 12_345_678n],
      ["Team plan, this month", 40_000_000n],
    ]);
    for (const entry of statement.entries) {
      expect(Object.keys(entry).sort()).toEqual(
        ["amountMicros", "createdAt", "description", "id", "kind"].sort(),
      );
    }
    // The plan's name and fee only: no multiplier or included usage.
    expect(statement.plan).toEqual({
      name: "Team",
      monthlyFeeMicros: 40_000_000n,
    });
    expect(statement.credit.usableMicros).toBe(5_000_000n);
    expect(statement.credit.grants).toHaveLength(1);
    expect(statement.more).toBe(false);

    const short = await getStatement(db, customer, new Date(), 2);
    expect(short.entries).toHaveLength(2);
    expect(
      JSON.stringify(statement.entries, (_k, v) =>
        typeof v === "bigint" ? String(v) : v,
      ),
    ).not.toMatch(/AI API cost|1.7500|6.000000/);
    expect(short.more).toBe(true);
  });

  it("is empty for a customer with nothing billed", async () => {
    expect(await getStatement(db, other)).toEqual({
      balanceMicros: 0n,
      entries: [],
      more: false,
      plan: null,
      credit: { usableMicros: 0n, grants: [] },
    });
  });
});
