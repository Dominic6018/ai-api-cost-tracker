import { and, eq, gt, isNull, lte, or, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { BudgetCheckInputs, CustomerInputs } from "@/lib/budget-check";
import { spendWindows } from "@/lib/spend";
import {
  billingCustomers,
  billingPlans,
  billingSubscriptions,
  budgetReservations,
  projects,
  usageEvents,
} from "./schema";

/** Any Drizzle Postgres database, so callers and tests can pass their own. */
type Database = Pick<PgDatabase<PgQueryResultHKT>, "select">;

/**
 * A project's caps, this UTC month's spend (counted like the dashboard,
 * from the start of the month) and, given a run ID, that run's total
 * spend across all time. One query; both sums use the
 * (project_id, occurred_at) and (project_id, run_id) indexes.
 * Undefined when the project doesn't exist.
 */
export async function getBudgetCheckInputs(
  db: Database,
  projectId: string,
  runId: string | undefined,
  now: Date = new Date(),
  customerId?: string,
): Promise<BudgetCheckInputs | undefined> {
  // postgres-js doesn't serialize Date objects in raw sql, so pass ISO text.
  const monthStart = spendWindows(now).month.toISOString();
  // Filter by the project ID as a parameter rather than correlating with
  // the outer row: in a single-table select Drizzle renders columns
  // unqualified, so `projects.id` would resolve to `usage_events.id` here.
  const sum = (where: ReturnType<typeof sql>) =>
    sql<string>`(select coalesce(sum(${usageEvents.costUsd}), 0)::numeric(14, 6)::text from ${usageEvents} where ${usageEvents.projectId} = ${projectId}::uuid and ${where})`;

  // Unexpired holds from POST /api/budget/reserve count like spend.
  const held = (where: ReturnType<typeof sql>) =>
    sql<string>`(select coalesce(sum(${budgetReservations.amountUsd}), 0)::numeric(14, 6)::text from ${budgetReservations} where ${budgetReservations.projectId} = ${projectId}::uuid and ${budgetReservations.status} = 'held' and ${budgetReservations.expiresAt} > ${now.toISOString()}::timestamptz and ${where})`;

  const [row] = await db
    .select({
      monthlyBudgetUsd: projects.monthlyBudgetUsd,
      runBudgetUsd: projects.runBudgetUsd,
      monthSpentUsd: sum(
        sql`${usageEvents.occurredAt} >= ${monthStart}::timestamptz`,
      ),
      runSpentUsd:
        runId === undefined
          ? sql<null>`null`
          : sum(sql`${usageEvents.runId} = ${runId}`),
      monthHeldUsd: held(sql`true`),
      runHeldUsd:
        runId === undefined
          ? sql<null>`null`
          : held(sql`${budgetReservations.runId} = ${runId}`),
    })
    .from(projects)
    .where(eq(projects.id, projectId));
  if (!row || customerId === undefined) return row;
  return {
    ...row,
    customer: await getCustomerInputs(db, projectId, customerId, now),
  };
}

/**
 * A customer's month against their plan's usage limit: the plan they're
 * on this UTC month, and their spend and unexpired holds across every
 * project in the project's organization. A customer that isn't a billing
 * customer, or has no plan, has no limit.
 */
export async function getCustomerInputs(
  db: Database,
  projectId: string,
  customerId: string,
  now: Date = new Date(),
): Promise<CustomerInputs> {
  const monthStart = spendWindows(now).month.toISOString();
  const month = monthStart.slice(0, 10);
  // Projects in the same organization as this one.
  const sameOrganization = sql`${projects.organizationId} = (select ${projects.organizationId} from ${projects} where ${projects.id} = ${projectId}::uuid)`;

  const [plan] = await db
    .select({
      slug: billingPlans.slug,
      limitUsd: billingPlans.monthlyUsageLimitUsd,
    })
    .from(billingCustomers)
    .innerJoin(
      billingSubscriptions,
      eq(billingSubscriptions.customerId, billingCustomers.id),
    )
    .innerJoin(billingPlans, eq(billingPlans.id, billingSubscriptions.planId))
    .where(
      and(
        sql`${billingCustomers.organizationId} = (select ${projects.organizationId} from ${projects} where ${projects.id} = ${projectId}::uuid)`,
        eq(billingCustomers.externalId, customerId),
        lte(billingSubscriptions.startsOn, month),
        or(
          isNull(billingSubscriptions.endsOn),
          gt(billingSubscriptions.endsOn, month),
        ),
      ),
    );
  const [spent] = await db
    .select({
      usd: sql<string>`coalesce(sum(${usageEvents.costUsd}), 0)::numeric(14, 6)::text`,
    })
    .from(usageEvents)
    .innerJoin(projects, eq(projects.id, usageEvents.projectId))
    .where(
      and(
        sameOrganization,
        eq(usageEvents.customerId, customerId),
        sql`${usageEvents.occurredAt} >= ${monthStart}::timestamptz`,
      ),
    );
  const [held] = await db
    .select({
      usd: sql<string>`coalesce(sum(${budgetReservations.amountUsd}), 0)::numeric(14, 6)::text`,
    })
    .from(budgetReservations)
    .innerJoin(projects, eq(projects.id, budgetReservations.projectId))
    .where(
      and(
        sameOrganization,
        eq(budgetReservations.customerId, customerId),
        eq(budgetReservations.status, "held"),
        sql`${budgetReservations.expiresAt} > ${now.toISOString()}::timestamptz`,
      ),
    );
  return {
    planSlug: plan?.slug ?? null,
    limitUsd: plan?.limitUsd ?? null,
    spentUsd: spent.usd,
    heldUsd: held.usd,
  };
}
