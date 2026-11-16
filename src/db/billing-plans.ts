import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  gte,
  isNull,
  lt,
  lte,
  or,
} from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { AuditEntry } from "@/lib/audit";
import { microsToDecimal } from "@/lib/budget";
import { monthStart, planCreatedEntry, subscriptionEntry } from "@/lib/billing";
import { audited, type AuditActor } from "./audit";
import {
  billingCustomers,
  billingPlans,
  billingSubscriptions,
  type BillingCustomer,
  type BillingPlan,
  type BillingSubscription,
} from "./schema";
import type { OrganizationScope } from "./scope";

type Database = Pick<
  PgDatabase<PgQueryResultHKT>,
  "select" | "insert" | "transaction"
>;
type Change<T> = { result: T; entry: AuditEntry | null };
type InOrganization = { organizationId: string };

export type CreatePlanResult =
  { ok: true; plan: BillingPlan } | { ok: false; error: "slug_taken" };

/** Adds a plan. Plans don't change afterwards; add another instead. */
export function createBillingPlan(
  db: Pick<Database, "transaction">,
  actor: AuditActor,
  input: InOrganization & {
    slug: string;
    name: string;
    monthlyFeeMicros: bigint;
    includedUsageMicros: bigint;
    usageMultiplier: string;
    /** The most AI API cost a customer may use in a month; null for none. */
    monthlyUsageLimitMicros?: bigint | null;
  },
): Promise<CreatePlanResult> {
  return audited(db, actor, async (tx): Promise<Change<CreatePlanResult>> => {
    const [plan] = await tx
      .insert(billingPlans)
      .values({
        organizationId: input.organizationId,
        slug: input.slug,
        name: input.name,
        monthlyFeeUsd: microsToDecimal(input.monthlyFeeMicros),
        includedUsageUsd: microsToDecimal(input.includedUsageMicros),
        usageMultiplier: input.usageMultiplier,
        monthlyUsageLimitUsd:
          input.monthlyUsageLimitMicros == null
            ? null
            : microsToDecimal(input.monthlyUsageLimitMicros),
      })
      .onConflictDoNothing()
      .returning();
    return plan
      ? { result: { ok: true, plan }, entry: planCreatedEntry(plan) }
      : { result: { ok: false, error: "slug_taken" }, entry: null };
  });
}

export async function findBillingPlan(
  db: Pick<Database, "select">,
  scope: InOrganization,
  slug: string,
): Promise<BillingPlan | undefined> {
  const [plan] = await db
    .select()
    .from(billingPlans)
    .where(
      and(
        eq(billingPlans.organizationId, scope.organizationId),
        eq(billingPlans.slug, slug),
      ),
    );
  return plan;
}

/** Plans, with how many customers are on each in `month`. */
export async function listBillingPlans(
  db: Pick<Database, "select">,
  scope: OrganizationScope,
  month: string,
): Promise<Array<{ plan: BillingPlan; customers: number }>> {
  return db
    .select({ plan: billingPlans, customers: count(billingSubscriptions.id) })
    .from(billingPlans)
    .leftJoin(
      billingSubscriptions,
      and(eq(billingSubscriptions.planId, billingPlans.id), covers(month)),
    )
    .where(
      "organizationId" in scope
        ? eq(billingPlans.organizationId, scope.organizationId)
        : undefined,
    )
    .groupBy(billingPlans.id)
    .orderBy(asc(billingPlans.slug));
}

/** Subscriptions in effect during the month starting `month`. */
function covers(month: string) {
  return and(
    lte(billingSubscriptions.startsOn, month),
    or(
      isNull(billingSubscriptions.endsOn),
      gt(billingSubscriptions.endsOn, month),
    ),
  );
}

/** The plan a customer is on in the month starting `month`, if any. */
export async function planForMonth(
  db: Pick<Database, "select">,
  customer: Pick<BillingCustomer, "id" | "organizationId">,
  month: string,
): Promise<{ subscription: BillingSubscription; plan: BillingPlan } | null> {
  const [row] = await db
    .select({ subscription: billingSubscriptions, plan: billingPlans })
    .from(billingSubscriptions)
    .innerJoin(billingPlans, eq(billingPlans.id, billingSubscriptions.planId))
    .where(
      and(
        eq(billingSubscriptions.organizationId, customer.organizationId),
        eq(billingSubscriptions.customerId, customer.id),
        covers(month),
      ),
    );
  return row ?? null;
}

/** A customer's plan history, latest first. */
export function listSubscriptions(
  db: Pick<Database, "select">,
  customer: Pick<BillingCustomer, "id" | "organizationId">,
): Promise<Array<{ subscription: BillingSubscription; plan: BillingPlan }>> {
  return db
    .select({ subscription: billingSubscriptions, plan: billingPlans })
    .from(billingSubscriptions)
    .innerJoin(billingPlans, eq(billingPlans.id, billingSubscriptions.planId))
    .where(
      and(
        eq(billingSubscriptions.organizationId, customer.organizationId),
        eq(billingSubscriptions.customerId, customer.id),
      ),
    )
    .orderBy(desc(billingSubscriptions.startsOn));
}

export type PlanChangeResult =
  | { ok: true; replaced: number }
  | { ok: false; error: "past_month" | "unchanged" };

/**
 * Puts a customer on `plan` from `from` (the first of a month), or takes
 * them off any plan when `plan` is null. Whatever was scheduled from that
 * month on is replaced. `from` can't be before the current UTC month, so
 * months that may have been billed never change.
 */
export function changePlan(
  db: Pick<Database, "transaction">,
  actor: AuditActor,
  customer: BillingCustomer,
  plan: BillingPlan | null,
  from: string,
  now: Date = new Date(),
): Promise<PlanChangeResult> {
  return audited(db, actor, async (tx): Promise<Change<PlanChangeResult>> => {
    if (from < monthStart(now)) {
      return { result: { ok: false, error: "past_month" }, entry: null };
    }
    // One change per customer at a time, so periods can't overlap.
    await tx
      .select({ id: billingCustomers.id })
      .from(billingCustomers)
      .where(eq(billingCustomers.id, customer.id))
      .for("update");

    const mine = and(
      eq(billingSubscriptions.organizationId, customer.organizationId),
      eq(billingSubscriptions.customerId, customer.id),
    );
    const later = await tx
      .select()
      .from(billingSubscriptions)
      .where(and(mine, gte(billingSubscriptions.startsOn, from)));
    const [covering] = await tx
      .select()
      .from(billingSubscriptions)
      .where(
        and(
          mine,
          lt(billingSubscriptions.startsOn, from),
          or(
            isNull(billingSubscriptions.endsOn),
            gt(billingSubscriptions.endsOn, from),
          ),
        ),
      );

    // Already on this plan from `from` or before, with nothing after it.
    const open = (s?: BillingSubscription) =>
      s !== undefined && s.planId === plan?.id && s.endsOn === null;
    const unchanged = plan
      ? (open(covering) && later.length === 0) ||
        (!covering &&
          later.length === 1 &&
          later[0].startsOn === from &&
          open(later[0]))
      : !covering && later.length === 0;
    if (unchanged) {
      return { result: { ok: false, error: "unchanged" }, entry: null };
    }

    if (later.length > 0) {
      await tx
        .delete(billingSubscriptions)
        .where(and(mine, gte(billingSubscriptions.startsOn, from)));
    }
    if (covering) {
      await tx
        .update(billingSubscriptions)
        .set({ endsOn: from })
        .where(eq(billingSubscriptions.id, covering.id));
    }
    if (plan) {
      await tx.insert(billingSubscriptions).values({
        organizationId: customer.organizationId,
        customerId: customer.id,
        planId: plan.id,
        startsOn: from,
      });
    }
    return {
      result: { ok: true, replaced: later.length },
      entry: subscriptionEntry({
        customerExternalId: customer.externalId,
        planSlug: plan?.slug ?? null,
        from,
        replaced: later.length,
        organizationId: customer.organizationId,
      }),
    };
  });
}

// For the CLI's listing: the month's plan per customer, by customer id.
export async function plansByCustomer(
  db: Pick<Database, "select">,
  scope: InOrganization,
  month: string,
): Promise<Map<string, BillingPlan>> {
  const rows = await db
    .select({ customerId: billingSubscriptions.customerId, plan: billingPlans })
    .from(billingSubscriptions)
    .innerJoin(billingPlans, eq(billingPlans.id, billingSubscriptions.planId))
    .where(
      and(
        eq(billingSubscriptions.organizationId, scope.organizationId),
        covers(month),
      ),
    );
  return new Map(rows.map((row) => [row.customerId, row.plan]));
}
