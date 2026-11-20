import "dotenv/config";
import { count, eq, like, ne } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { parseEnv } from "@/lib/env";
import { getStatement, openPortal } from "../billing-portal";
import {
  billingCustomers,
  organizations,
  projects,
  usageEvents,
} from "../schema";
import {
  BILLING_DEMO_SLUG,
  removeBillingDemo,
  runBillingDemo,
} from "./billing";

// Runs against the database in DATABASE_URL after `npm run db:migrate` and
// `npm run db:seed`, which the demo's usage is priced with.
const client = postgres(parseEnv().DATABASE_URL, {
  max: 1,
  onnotice: () => {},
});
const db = drizzle(client);

const NOW = new Date("2026-11-21T09:00:00Z");

afterAll(async () => {
  await removeBillingDemo(db);
  await client.end();
});

const otherProjects = async () =>
  (
    await db
      .select({ n: count() })
      .from(projects)
      .innerJoin(organizations, eq(organizations.id, projects.organizationId))
      .where(ne(organizations.slug, BILLING_DEMO_SLUG))
  )[0].n;

describe("the usage-based billing demo", () => {
  it("bills last month: fees, usage beyond the allowance, credit", async () => {
    const before = await otherProjects();
    const result = await runBillingDemo(db, NOW);
    expect(result.month).toBe("2026-10-01");
    expect(
      result.customers.map((c) => [
        c.externalId,
        c.aiCostMicros,
        c.charges.feeMicros,
        c.charges.billableUsageMicros,
        c.creditAppliedMicros,
        c.balanceMicros,
      ]),
    ).toEqual([
      // $12 of AI usage × 1.5 = $18, less $10 included.
      ["cus_brightline", 12_000_000n, 29_000_000n, 8_000_000n, 0n, 37_000_000n],
      // $160 × 1.25 = $200, less $150 included.
      ["cus_harbor", 160_000_000n, 199_000_000n, 50_000_000n, 0n, 249_000_000n],
      // $4 × 1.5 = $6, within the $10 included; $20 of credit pays $20.
      ["cus_quill", 4_000_000n, 29_000_000n, 0n, 20_000_000n, 9_000_000n],
    ]);
    expect(result.revenue.total).toMatchObject({
      revenueMicros: 315_000_000n,
      costMicros: 176_000_000n,
      differenceMicros: 139_000_000n,
      sharePermille: 441,
    });
    // The usage is dated last month, and nothing else was touched.
    const events = await db
      .select({ occurredAt: usageEvents.occurredAt })
      .from(usageEvents)
      .where(like(usageEvents.requestId, "demo-billing-%"));
    expect(events).toHaveLength(176);
    for (const { occurredAt } of events) {
      expect(occurredAt.toISOString().slice(0, 7)).toBe("2026-10");
    }
    expect(await otherProjects()).toBe(before);
  });

  it("gives the first customer a portal showing their bill, not its cost", async () => {
    const result = await runBillingDemo(db, NOW);
    const opened = await openPortal(db, result.portal.token, NOW);
    expect(opened?.customer.externalId).toBe("cus_brightline");
    const statement = await getStatement(db, opened!.customer, NOW);
    expect(statement.balanceMicros).toBe(37_000_000n);
    expect(statement.entries.map((e) => e.description).sort()).toEqual([
      "Starter plan, 2026-10",
      "Usage, 2026-10",
    ]);
    // Still subscribed: the plan, by name and fee only.
    expect(statement.plan).toEqual({
      name: "Starter",
      monthlyFeeMicros: 29_000_000n,
    });
  });

  it("starts over when run again, and removes cleanly", async () => {
    await runBillingDemo(db, NOW);
    await runBillingDemo(db, NOW);
    const [{ n: customers }] = await db
      .select({ n: count() })
      .from(billingCustomers)
      .innerJoin(
        organizations,
        eq(organizations.id, billingCustomers.organizationId),
      )
      .where(eq(organizations.slug, BILLING_DEMO_SLUG));
    expect(customers).toBe(3);

    expect(await removeBillingDemo(db)).toBe(true);
    expect(await removeBillingDemo(db)).toBe(false);
    const [{ n: left }] = await db
      .select({ n: count() })
      .from(usageEvents)
      .where(like(usageEvents.requestId, "demo-billing-%"));
    expect(left).toBe(0);
  });
});
