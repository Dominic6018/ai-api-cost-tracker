import "dotenv/config";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { parseEnv } from "@/lib/env";
import { COMMAND_LINE, type AuditActor } from "./audit";
import { createBillingCustomer, listBillingCustomers } from "./billing";
import {
  chargeMonth,
  customersOnPlans,
  usageForMonth,
} from "./billing-charges";
import { changePlan, createBillingPlan } from "./billing-plans";
import {
  auditLog,
  billingLedgerEntries,
  organizations,
  projects,
  usageEvents,
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
    // Projects (and their usage) first: they don't cascade from organizations.
    await db
      .delete(projects)
      .where(inArray(projects.organizationId, organizationIds));
    await db
      .delete(organizations)
      .where(inArray(organizations.id, organizationIds));
  }
  await client.end();
});

// Plans start in September, and October is charged in December, so the
// test doesn't depend on today's date.
const SEPTEMBER = new Date("2026-09-15T12:00:00Z");
const DECEMBER = new Date("2026-12-15T12:00:00Z");
const OCTOBER = "2026-10-01";

async function setup(externalId = "cus_42") {
  const [organization] = await db
    .insert(organizations)
    .values({ name: "Charges test", slug: `it-${randomUUID()}` })
    .returning();
  organizationIds.push(organization.id);
  const scope = { organizationId: organization.id };
  const actor: AuditActor = {
    ...COMMAND_LINE,
    organizationId: organization.id,
  };
  const [project, other] = await db
    .insert(projects)
    .values(
      ["a", "b"].map((s) => ({
        organizationId: organization.id,
        name: `Project ${s}`,
        slug: `it-${s}-${randomUUID()}`,
      })),
    )
    .returning();
  const created = await createBillingCustomer(db, actor, {
    ...scope,
    externalId,
    name: "Acme",
  });
  if (!created.ok) throw new Error("customer not created");
  const plan = async (
    slug: string,
    terms: { fee: bigint; included: bigint; multiplier: string },
  ) => {
    const result = await createBillingPlan(db, actor, {
      ...scope,
      slug,
      name: slug,
      monthlyFeeMicros: terms.fee,
      includedUsageMicros: terms.included,
      usageMultiplier: terms.multiplier,
    });
    if (!result.ok) throw new Error("plan not created");
    return result.plan;
  };
  const usage = (
    costUsd: string | null,
    occurredAt: string,
    options: { customerId?: string; projectId?: string } = {},
  ) =>
    db.insert(usageEvents).values({
      projectId: options.projectId ?? project.id,
      provider: "openai",
      model: "gpt-4.1",
      inputTokens: 1000,
      outputTokens: 100,
      costUsd,
      pricingStatus: costUsd === null ? "unpriced" : "priced",
      unpricedReason: costUsd === null ? "no_pricing" : null,
      occurredAt: new Date(occurredAt),
      customerId: options.customerId ?? externalId,
    });
  return {
    organization,
    scope,
    actor,
    customer: created.customer,
    projects: [project, other],
    plan,
    usage,
  };
}

const PRO = { fee: 49_000_000n, included: 20_000_000n, multiplier: "1.25" };

describe("charging a month", () => {
  it("posts the fee and usage beyond the allowance, exactly", async () => {
    const t = await setup();
    const pro = await t.plan("pro", PRO);
    await changePlan(db, t.actor, t.customer, pro, "2026-09-01", SEPTEMBER);
    // $30.000001 of October usage across both projects.
    await t.usage("12.500000", "2026-10-01T00:00:00Z");
    await t.usage("17.500001", "2026-10-31T23:59:59Z", {
      projectId: t.projects[1].id,
    });
    // Not October, not this customer, or not this organization.
    await t.usage("100", "2026-09-30T23:59:59Z");
    await t.usage("100", "2026-11-01T00:00:00Z");
    await t.usage("100", "2026-10-15T00:00:00Z", { customerId: "cus_other" });
    const elsewhere = await setup();
    await elsewhere.usage("100", "2026-10-15T00:00:00Z");

    expect(await usageForMonth(db, t.customer, OCTOBER)).toEqual({
      costMicros: 30_000_001n,
      requests: 2,
      unpriced: 0,
    });
    const result = await chargeMonth(
      db,
      t.actor,
      t.customer,
      OCTOBER,
      DECEMBER,
    );
    if (!result.ok) throw new Error(result.error);
    expect(result.posted).toBe(true);
    // $30.000001 x 1.25 = $37.50000125 -> $37.500001, less $20 included.
    expect(result.charges.billableUsageMicros).toBe(17_500_001n);
    const entries = result.entries.map((e) => ({
      kind: e.kind,
      amountUsd: e.amountUsd,
      period: e.period,
      planId: e.planId,
      usageCostUsd: e.usageCostUsd,
    }));
    expect(entries).toEqual(
      expect.arrayContaining([
        {
          kind: "plan_fee",
          amountUsd: "49.000000",
          period: OCTOBER,
          planId: pro.id,
          usageCostUsd: null,
        },
        {
          kind: "usage_charge",
          amountUsd: "17.500001",
          period: OCTOBER,
          planId: pro.id,
          usageCostUsd: "30.000001",
        },
      ]),
    );
    expect(entries).toHaveLength(2);
    const [row] = await listBillingCustomers(db, t.scope);
    expect(row.balanceMicros).toBe(66_500_001n);
    const audited = await db
      .select({ action: auditLog.action, details: auditLog.details })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.organizationId, t.organization.id),
          eq(auditLog.action, "billing.charged"),
        ),
      );
    expect(audited).toEqual([
      {
        action: "billing.charged",
        details: {
          month: "2026-10",
          plan: "pro",
          feeUsd: "49.000000",
          usageUsd: "17.500001",
          usageCostUsd: "30.000001",
        },
      },
    ]);
  });

  it("charges a month once, even when run at the same moment", async () => {
    const t = await setup();
    const pro = await t.plan("pro", PRO);
    await changePlan(db, t.actor, t.customer, pro, "2026-09-01", SEPTEMBER);
    await t.usage("40", "2026-10-10T00:00:00Z");
    const results = await Promise.all(
      [1, 2, 3].map(() =>
        chargeMonth(db, t.actor, t.customer, OCTOBER, DECEMBER),
      ),
    );
    expect(results.filter((r) => r.ok && r.posted)).toHaveLength(1);
    expect(results.filter((r) => r.ok && !r.posted)).toHaveLength(2);
    // Usage recorded later for October isn't charged by running again.
    await t.usage("1000", "2026-10-20T00:00:00Z");
    const again = await chargeMonth(db, t.actor, t.customer, OCTOBER, DECEMBER);
    expect(again).toMatchObject({ ok: true, posted: false });
    const stored = await db
      .select()
      .from(billingLedgerEntries)
      .where(eq(billingLedgerEntries.customerId, t.customer.id));
    expect(stored.map((e) => e.amountUsd).sort()).toEqual([
      "30.000000",
      "49.000000",
    ]);
  });

  it("refuses unfinished months, and months with unpriced usage", async () => {
    const t = await setup();
    const pro = await t.plan("pro", PRO);
    await changePlan(db, t.actor, t.customer, pro, "2026-09-01", SEPTEMBER);
    for (const month of ["2026-12-01", "2027-01-01"]) {
      expect(
        await chargeMonth(db, t.actor, t.customer, month, DECEMBER),
      ).toEqual({ ok: false, error: "open_month" });
    }
    await t.usage("10", "2026-10-03T00:00:00Z");
    await t.usage(null, "2026-10-04T00:00:00Z");
    expect(
      await chargeMonth(db, t.actor, t.customer, OCTOBER, DECEMBER),
    ).toEqual({ ok: false, error: "unpriced_usage", unpriced: 1 });
    expect(
      await db
        .select()
        .from(billingLedgerEntries)
        .where(eq(billingLedgerEntries.customerId, t.customer.id)),
    ).toEqual([]);
  });

  it("bills each month on the plan of that month", async () => {
    const t = await setup();
    const basic = await t.plan("basic", {
      fee: 10_000_000n,
      included: 0n,
      multiplier: "1",
    });
    const pro = await t.plan("pro", PRO);
    await changePlan(db, t.actor, t.customer, basic, "2026-09-01", SEPTEMBER);
    await changePlan(db, t.actor, t.customer, pro, "2026-10-01", SEPTEMBER);
    await t.usage("5", "2026-09-10T00:00:00Z");
    await t.usage("5", "2026-10-10T00:00:00Z");

    const september = await chargeMonth(
      db,
      t.actor,
      t.customer,
      "2026-09-01",
      DECEMBER,
    );
    const october = await chargeMonth(
      db,
      t.actor,
      t.customer,
      OCTOBER,
      DECEMBER,
    );
    if (!september.ok || !october.ok) throw new Error("expected charges");
    expect(september.planSlug).toBe("basic");
    expect(september.entries.map((e) => e.amountUsd).sort()).toEqual([
      "10.000000",
      "5.000000",
    ]);
    // Pro: $5 x 1.25 = $6.25 is within the $20 allowance, so only the fee.
    expect(october.planSlug).toBe("pro");
    expect(october.entries.map((e) => e.kind)).toEqual(["plan_fee"]);
    expect(
      await chargeMonth(db, t.actor, t.customer, "2026-08-01", DECEMBER),
    ).toEqual({ ok: false, error: "no_plan" });
  });

  it("posts nothing when a month comes to zero", async () => {
    const t = await setup();
    const free = await t.plan("free", {
      fee: 0n,
      included: 5_000_000n,
      multiplier: "1",
    });
    await changePlan(db, t.actor, t.customer, free, "2026-09-01", SEPTEMBER);
    await t.usage("1", "2026-10-10T00:00:00Z");
    expect(
      await chargeMonth(db, t.actor, t.customer, OCTOBER, DECEMBER),
    ).toMatchObject({ ok: true, posted: false, entries: [] });
  });

  it("lists the customers on a plan in the month", async () => {
    const t = await setup();
    const pro = await t.plan("pro", PRO);
    expect(await customersOnPlans(db, t.scope, OCTOBER)).toEqual([]);
    await changePlan(db, t.actor, t.customer, pro, "2026-10-01", SEPTEMBER);
    expect(
      (await customersOnPlans(db, t.scope, OCTOBER)).map((c) => c.externalId),
    ).toEqual(["cus_42"]);
    expect(await customersOnPlans(db, t.scope, "2026-09-01")).toEqual([]);
  });
});

describe("the database guards monthly charges", () => {
  it("refuses a second charge for a month, credits, and charges without a period", async () => {
    const t = await setup();
    const pro = await t.plan("pro", PRO);
    const base = {
      organizationId: t.organization.id,
      customerId: t.customer.id,
      kind: "plan_fee" as const,
      amountUsd: "49",
      description: "Fee",
      createdBy: "test",
      planId: pro.id,
      period: OCTOBER,
    };
    await db.insert(billingLedgerEntries).values(base);
    for (const values of [
      base,
      { ...base, period: "2026-11-01", amountUsd: "-49" },
      { ...base, period: null },
      { ...base, period: "2026-11-15" },
      { ...base, kind: "usage_charge" as const, period: "2026-11-01" },
    ]) {
      await expect(
        db.insert(billingLedgerEntries).values(values),
      ).rejects.toThrow();
    }
  });
});
