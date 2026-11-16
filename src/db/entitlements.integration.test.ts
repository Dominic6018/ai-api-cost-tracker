import "dotenv/config";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { monthStart } from "@/lib/billing";
import { decideBudgetCheck } from "@/lib/budget-check";
import { parseEnv } from "@/lib/env";
import { COMMAND_LINE, type AuditActor } from "./audit";
import { createBillingCustomer } from "./billing";
import { changePlan, createBillingPlan } from "./billing-plans";
import { getBudgetCheckInputs, getCustomerInputs } from "./budget-check";
import { reserveBudget } from "./budget-reservations";
import { auditLog, organizations, projects, usageEvents } from "./schema";

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
      .delete(projects)
      .where(inArray(projects.organizationId, organizationIds));
    await db
      .delete(organizations)
      .where(inArray(organizations.id, organizationIds));
  }
  await client.end();
});

/**
 * An organization with two projects and customer cus_42 on a plan with a
 * $10 monthly usage limit, who has used $8 this month in the first.
 */
async function setup(limitMicros: bigint | null = 10_000_000n) {
  const now = new Date();
  const [organization] = await db
    .insert(organizations)
    .values({ name: "Entitlements test", slug: `it-${randomUUID()}` })
    .returning();
  organizationIds.push(organization.id);
  const scope = { organizationId: organization.id };
  const actor: AuditActor = {
    ...COMMAND_LINE,
    organizationId: organization.id,
  };
  const [a, b] = await db
    .insert(projects)
    .values(
      ["a", "b"].map((s) => ({
        organizationId: organization.id,
        name: `Project ${s}`,
        slug: `it-${s}-${randomUUID()}`,
      })),
    )
    .returning();
  const customer = await createBillingCustomer(db, actor, {
    ...scope,
    externalId: "cus_42",
    name: "Acme",
  });
  if (!customer.ok) throw new Error("customer not created");
  const plan = await createBillingPlan(db, actor, {
    ...scope,
    slug: "pro",
    name: "Pro",
    monthlyFeeMicros: 0n,
    includedUsageMicros: 0n,
    usageMultiplier: "1",
    monthlyUsageLimitMicros: limitMicros,
  });
  if (!plan.ok) throw new Error("plan not created");
  await changePlan(
    db,
    actor,
    customer.customer,
    plan.plan,
    monthStart(now),
    now,
  );
  const usage = (
    projectId: string,
    costUsd: string,
    customerId: string,
    occurredAt = now,
  ) =>
    db.insert(usageEvents).values({
      projectId,
      provider: "openai",
      model: "gpt-4.1",
      costUsd,
      occurredAt,
      customerId,
    });
  await usage(a.id, "8", "cus_42");
  return { organization, actor, projects: [a, b], usage, now };
}

describe("a customer's monthly usage limit", () => {
  it("counts the customer's spend this month across the organization", async () => {
    const t = await setup();
    const [a, b] = t.projects;
    // Another customer, last month, and another organization don't count.
    await t.usage(b.id, "100", "cus_other");
    const lastMonth = new Date(
      Date.parse(`${monthStart(t.now)}T00:00:00Z`) - 1000,
    );
    await t.usage(b.id, "50", "cus_42", lastMonth);
    const elsewhere = await setup();
    await elsewhere.usage(elsewhere.projects[0].id, "1000", "cus_42");

    // Asked from either project, the answer is the same.
    for (const project of [a, b]) {
      expect(await getCustomerInputs(db, project.id, "cus_42")).toEqual({
        planSlug: "pro",
        limitUsd: "10.000000",
        spentUsd: "8.000000",
        heldUsd: "0.000000",
      });
    }
    const inputs = await getBudgetCheckInputs(
      db,
      b.id,
      undefined,
      t.now,
      "cus_42",
    );
    const decision = decideBudgetCheck(
      { estimateMicros: 2_000_001n, customerId: "cus_42" },
      inputs!,
      t.now,
    );
    expect([decision.allowed, decision.reasons]).toEqual([
      false,
      ["customer_limit"],
    ]);
  });

  it("has no limit for an unknown customer, or a plan without one", async () => {
    const t = await setup(null);
    expect(
      await getCustomerInputs(db, t.projects[0].id, "cus_42"),
    ).toMatchObject({ planSlug: "pro", limitUsd: null, spentUsd: "8.000000" });
    expect(
      await getCustomerInputs(db, t.projects[0].id, "cus_unknown"),
    ).toEqual({
      planSlug: null,
      limitUsd: null,
      spentUsd: "0.000000",
      heldUsd: "0.000000",
    });
  });

  it("holds count against the limit in every project", async () => {
    const t = await setup();
    const [a, b] = t.projects;
    const reserve = (projectId: string, id: string, micros: bigint) =>
      reserveBudget(db, projectId, {
        reservationId: id,
        estimateMicros: micros,
        customerId: "cus_42",
        ttlSeconds: 600,
      });
    const first = await reserve(b.id, "step-1", 1_500_000n);
    expect(first).toMatchObject({
      ok: true,
      decision: { allowed: true },
      reservation: { customerId: "cus_42" },
    });
    // $8 spent + $1.50 held leaves $0.50.
    const second = await reserve(a.id, "step-2", 600_000n);
    expect(second).toMatchObject({
      ok: true,
      decision: { allowed: false, reasons: ["customer_limit"] },
      reservation: null,
    });
    expect((await getCustomerInputs(db, a.id, "cus_42")).heldUsd).toBe(
      "1.500000",
    );
    // A retry naming a different customer is a conflict.
    expect(
      await reserveBudget(db, b.id, {
        reservationId: "step-1",
        estimateMicros: 1_500_000n,
        ttlSeconds: 600,
      }),
    ).toEqual({ ok: false, error: "reservation_conflict" });
  });

  it("lets only what fits through when reserved in two projects at once", async () => {
    const t = await setup();
    const [a, b] = t.projects;
    // $2 left: two holds of $1.50 can't both fit.
    const results = await Promise.all(
      [a, b, a, b].map((project, i) =>
        reserveBudget(db, project.id, {
          reservationId: `race-${i}`,
          estimateMicros: 1_500_000n,
          customerId: "cus_42",
          ttlSeconds: 600,
        }),
      ),
    );
    const allowed = results.filter(
      (r) => r.ok && r.decision.allowed && r.reservation,
    );
    expect(allowed).toHaveLength(1);
    expect((await getCustomerInputs(db, a.id, "cus_42")).heldUsd).toBe(
      "1.500000",
    );
  });
});
