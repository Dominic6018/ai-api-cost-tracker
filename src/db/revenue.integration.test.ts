import "dotenv/config";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { parseEnv } from "@/lib/env";
import { revenueReport } from "@/lib/revenue";
import { COMMAND_LINE, type AuditActor } from "./audit";
import { createBillingCustomer } from "./billing";
import { createBillingPlan } from "./billing-plans";
import { getRevenueInputs } from "./revenue";
import {
  auditLog,
  billingLedgerEntries,
  organizations,
  projects,
  usageEvents,
} from "./schema";

// Runs against the database in DATABASE_URL after `npm run db:migrate`.
const client = postgres(parseEnv().DATABASE_URL, {
  max: 1,
  onnotice: () => {},
});
const db = drizzle(client);

const organizationIds: string[] = [];

afterAll(async () => {
  if (organizationIds.length > 0) {
    await db
      .delete(auditLog)
      .where(inArray(auditLog.organizationId, organizationIds));
    await db
      .delete(projects)
      .where(inArray(projects.organizationId, organizationIds));
    await db
      .delete(organizations)
      .where(inArray(organizations.id, organizationIds));
  }
  await client.end();
});

const OCTOBER = "2026-10-01";

async function setup() {
  const [organization] = await db
    .insert(organizations)
    .values({ name: "Revenue test", slug: `it-${randomUUID()}` })
    .returning();
  organizationIds.push(organization.id);
  const scope = { organizationId: organization.id };
  const actor: AuditActor = {
    ...COMMAND_LINE,
    organizationId: organization.id,
  };
  const [project] = await db
    .insert(projects)
    .values({
      organizationId: organization.id,
      name: "Project",
      slug: `it-${randomUUID()}`,
    })
    .returning();
  const created = await createBillingCustomer(db, actor, {
    ...scope,
    externalId: "cus_a",
    name: "Acme",
  });
  if (!created.ok) throw new Error("customer not created");
  const plan = await createBillingPlan(db, actor, {
    ...scope,
    slug: "pro",
    name: "Pro",
    monthlyFeeMicros: 49_000_000n,
    includedUsageMicros: 0n,
    usageMultiplier: "1",
  });
  if (!plan.ok) throw new Error("plan not created");
  const entry = (
    values: Partial<typeof billingLedgerEntries.$inferInsert> & {
      kind: (typeof billingLedgerEntries.$inferInsert)["kind"];
      amountUsd: string;
    },
  ) =>
    db
      .insert(billingLedgerEntries)
      .values({
        organizationId: organization.id,
        customerId: created.customer.id,
        description: "Test",
        createdBy: "test",
        ...values,
      })
      .returning()
      .then(([row]) => row);
  const usage = (
    costUsd: string | null,
    customerId: string | null,
    occurredAt = "2026-10-15T12:00:00Z",
    projectId = project.id,
  ) =>
    db.insert(usageEvents).values({
      projectId,
      provider: "openai",
      model: "gpt-4.1",
      costUsd,
      pricingStatus: costUsd === null ? "unpriced" : "priced",
      unpricedReason: costUsd === null ? "no_pricing" : null,
      occurredAt: new Date(occurredAt),
      customerId,
    });
  return { organization, scope, plan: plan.plan, entry, usage, project };
}

describe("revenue and AI API cost by customer", () => {
  it("counts what was billed for the month against what the usage cost", async () => {
    const t = await setup();
    const planned = { planId: t.plan.id, period: OCTOBER };
    // October's charges, posted in November.
    await t.entry({
      ...planned,
      kind: "plan_fee",
      amountUsd: "49",
      createdAt: new Date("2026-11-02T00:00:00Z"),
    });
    await t.entry({
      ...planned,
      kind: "usage_charge",
      amountUsd: "17",
      usageCostUsd: "30",
      createdAt: new Date("2026-11-02T00:00:00Z"),
    });
    // An adjustment made in October counts; one made in November doesn't.
    const fix = await t.entry({
      kind: "adjustment",
      amountUsd: "5.5",
      createdAt: new Date("2026-10-20T00:00:00Z"),
    });
    await t.entry({
      kind: "adjustment",
      amountUsd: "100",
      createdAt: new Date("2026-11-20T00:00:00Z"),
    });
    // A reversal in October counts in October, whatever it reverses.
    await t.entry({
      kind: "reversal",
      amountUsd: "-5.5",
      reversesEntryId: fix.id,
      createdAt: new Date("2026-10-21T00:00:00Z"),
    });
    // Applied credit pays a bill; it isn't less revenue.
    await t.entry({
      kind: "credit_applied",
      amountUsd: "-66",
      createdAt: new Date("2026-10-25T00:00:00Z"),
    });

    await t.usage("30", "cus_a");
    await t.usage("2.5", "cus_unbilled");
    await t.usage(null, "cus_unbilled");
    await t.usage("1", null);
    await t.usage("1000", "cus_a", "2026-11-01T00:00:00Z");
    const elsewhere = await setup();
    await elsewhere.usage("1000", "cus_a");

    const inputs = await getRevenueInputs(db, t.scope, OCTOBER);
    const { rows, total } = revenueReport(inputs);
    expect(
      rows.map((r) => ({
        customerId: r.customerId,
        name: r.name,
        revenue: r.revenueMicros,
        cost: r.costMicros,
        difference: r.differenceMicros,
        unpriced: r.unpriced,
      })),
    ).toEqual([
      {
        customerId: "cus_a",
        name: "Acme",
        revenue: 66_000_000n,
        cost: 30_000_000n,
        difference: 36_000_000n,
        unpriced: 0,
      },
      {
        customerId: "cus_unbilled",
        name: null,
        revenue: 0n,
        cost: 2_500_000n,
        difference: -2_500_000n,
        unpriced: 1,
      },
      {
        customerId: null,
        name: null,
        revenue: 0n,
        cost: 1_000_000n,
        difference: -1_000_000n,
        unpriced: 0,
      },
    ]);
    expect(total).toMatchObject({
      revenueMicros: 66_000_000n,
      costMicros: 33_500_000n,
      unpriced: 1,
    });
  });

  it("is empty for a month with nothing billed or used", async () => {
    const t = await setup();
    expect(await getRevenueInputs(db, t.scope, OCTOBER)).toEqual([]);
  });
});
