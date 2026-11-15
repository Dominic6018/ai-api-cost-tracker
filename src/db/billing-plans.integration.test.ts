import "dotenv/config";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { parseEnv } from "@/lib/env";
import { COMMAND_LINE, type AuditActor } from "./audit";
import { createBillingCustomer } from "./billing";
import {
  changePlan,
  createBillingPlan,
  findBillingPlan,
  listBillingPlans,
  listSubscriptions,
  planForMonth,
} from "./billing-plans";
import {
  auditLog,
  billingPlans,
  billingSubscriptions,
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
    await db
      .delete(organizations)
      .where(inArray(organizations.id, organizationIds));
  }
  await client.end();
});

// A fixed "now", so the months below don't depend on when tests run.
const NOW = new Date("2026-11-15T12:00:00Z");

async function setup() {
  const [organization] = await db
    .insert(organizations)
    .values({ name: "Plans test", slug: `it-${randomUUID()}` })
    .returning();
  organizationIds.push(organization.id);
  const scope = { organizationId: organization.id };
  const actor: AuditActor = {
    ...COMMAND_LINE,
    organizationId: organization.id,
  };
  const customer = await createBillingCustomer(db, actor, {
    ...scope,
    externalId: "cus_42",
    name: "Acme",
  });
  if (!customer.ok) throw new Error("customer not created");
  const plan = async (slug: string, fee = 49_000_000n) => {
    const created = await createBillingPlan(db, actor, {
      ...scope,
      slug,
      name: slug,
      monthlyFeeMicros: fee,
      includedUsageMicros: 20_000_000n,
      usageMultiplier: "1.2500",
    });
    if (!created.ok) throw new Error("plan not created");
    return created.plan;
  };
  return { organization, scope, actor, customer: customer.customer, plan };
}

const periods = async (customer: { id: string; organizationId: string }) =>
  (await listSubscriptions(db, customer))
    .map(
      ({ subscription, plan }) =>
        `${plan.slug} ${subscription.startsOn}..${subscription.endsOn ?? ""}`,
    )
    .reverse();

describe("billing plans", () => {
  it("stores a plan's terms exactly, once per slug", async () => {
    const { scope, actor, plan } = await setup();
    const pro = await plan("pro");
    expect(pro).toMatchObject({
      monthlyFeeUsd: "49.000000",
      includedUsageUsd: "20.000000",
      usageMultiplier: "1.2500",
    });
    expect(
      await createBillingPlan(db, actor, {
        ...scope,
        slug: "pro",
        name: "Again",
        monthlyFeeMicros: 1n,
        includedUsageMicros: 0n,
        usageMultiplier: "1.0000",
      }),
    ).toEqual({ ok: false, error: "slug_taken" });
    expect((await findBillingPlan(db, scope, "pro"))?.id).toBe(pro.id);
    // Another organization's plans aren't visible.
    const other = await setup();
    expect(await findBillingPlan(db, other.scope, "pro")).toBeUndefined();
  });

  it("refuses negative terms in the database", async () => {
    const { organization } = await setup();
    await expect(
      db.insert(billingPlans).values({
        organizationId: organization.id,
        slug: "bad",
        name: "Bad",
        monthlyFeeUsd: "-1",
        includedUsageUsd: "0",
        usageMultiplier: "1",
      }),
    ).rejects.toThrow();
  });
});

describe("subscriptions", () => {
  it("changes plans by month, keeping earlier months as they were", async () => {
    const { organization, actor, customer, plan } = await setup();
    const basic = await plan("basic");
    const pro = await plan("pro");

    expect(
      await changePlan(db, actor, customer, basic, "2026-11-01", NOW),
    ).toEqual({ ok: true, replaced: 0 });
    expect(
      await changePlan(db, actor, customer, pro, "2027-01-01", NOW),
    ).toEqual({ ok: true, replaced: 0 });
    expect(await periods(customer)).toEqual([
      "basic 2026-11-01..2027-01-01",
      "pro 2027-01-01..",
    ]);

    expect((await planForMonth(db, customer, "2026-12-01"))?.plan.slug).toBe(
      "basic",
    );
    expect((await planForMonth(db, customer, "2027-03-01"))?.plan.slug).toBe(
      "pro",
    );
    expect(await planForMonth(db, customer, "2026-10-01")).toBeNull();

    const audited = await db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(eq(auditLog.organizationId, organization.id));
    expect(audited.map((a) => a.action).sort()).toEqual([
      "billing.customer_created",
      "billing.plan_created",
      "billing.plan_created",
      "billing.subscribed",
      "billing.subscribed",
    ]);
  });

  it("replaces what was scheduled from the month on", async () => {
    const { actor, customer, plan } = await setup();
    const basic = await plan("basic");
    const pro = await plan("pro");
    const team = await plan("team");
    await changePlan(db, actor, customer, basic, "2026-11-01", NOW);
    await changePlan(db, actor, customer, pro, "2027-01-01", NOW);

    // Team from December replaces the scheduled move to Pro.
    expect(
      await changePlan(db, actor, customer, team, "2026-12-01", NOW),
    ).toEqual({ ok: true, replaced: 1 });
    expect(await periods(customer)).toEqual([
      "basic 2026-11-01..2026-12-01",
      "team 2026-12-01..",
    ]);

    // Unsubscribing from February ends it there.
    expect(
      await changePlan(db, actor, customer, null, "2027-02-01", NOW),
    ).toEqual({ ok: true, replaced: 0 });
    expect(await periods(customer)).toEqual([
      "basic 2026-11-01..2026-12-01",
      "team 2026-12-01..2027-02-01",
    ]);
  });

  it("refuses past months and changes that change nothing", async () => {
    const { actor, customer, plan } = await setup();
    const basic = await plan("basic");
    expect(
      await changePlan(db, actor, customer, basic, "2026-10-01", NOW),
    ).toEqual({ ok: false, error: "past_month" });
    expect(
      await changePlan(db, actor, customer, null, "2026-12-01", NOW),
    ).toEqual({ ok: false, error: "unchanged" });

    await changePlan(db, actor, customer, basic, "2026-11-01", NOW);
    for (const from of ["2026-11-01", "2027-05-01"]) {
      expect(await changePlan(db, actor, customer, basic, from, NOW)).toEqual({
        ok: false,
        error: "unchanged",
      });
    }
    expect(await periods(customer)).toEqual(["basic 2026-11-01.."]);
  });

  it("never overlaps, even with changes at the same moment", async () => {
    const { actor, customer, plan } = await setup();
    const plans = await Promise.all(["a", "b", "c", "d"].map((s) => plan(s)));
    await Promise.all(
      plans.map((p, i) =>
        changePlan(db, actor, customer, p, `2027-0${(i % 2) + 1}-01`, NOW),
      ),
    );
    const rows = (await listSubscriptions(db, customer)).map(
      (r) => r.subscription,
    );
    expect(rows.filter((s) => s.endsOn === null)).toHaveLength(1);
    const sorted = [...rows].sort((x, y) =>
      x.startsOn.localeCompare(y.startsOn),
    );
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i - 1].endsOn).not.toBeNull();
      expect(sorted[i - 1].endsOn! <= sorted[i].startsOn).toBe(true);
    }
  });

  it("keeps the customer and plan in the subscription's organization", async () => {
    const { organization, customer, plan } = await setup();
    const other = await setup();
    const foreign = await other.plan("pro");
    await expect(
      db.insert(billingSubscriptions).values({
        organizationId: organization.id,
        customerId: customer.id,
        planId: foreign.id,
        startsOn: "2027-01-01",
      }),
    ).rejects.toThrow();
    // Months start on the 1st and end after they start.
    const own = await plan("x");
    await expect(
      db.insert(billingSubscriptions).values({
        organizationId: own.organizationId,
        customerId: customer.id,
        planId: own.id,
        startsOn: "2027-01-15",
      }),
    ).rejects.toThrow();
  });

  it("counts a plan's customers in a month", async () => {
    const { scope, actor, customer, plan } = await setup();
    const pro = await plan("pro");
    await changePlan(db, actor, customer, pro, "2027-01-01", NOW);
    const count = async (month: string) =>
      (await listBillingPlans(db, scope, month)).map((r) => r.customers);
    expect(await count("2026-12-01")).toEqual([0]);
    expect(await count("2027-01-01")).toEqual([1]);
  });
});
