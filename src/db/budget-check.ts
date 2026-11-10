import { eq, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { BudgetCheckInputs } from "@/lib/budget-check";
import { spendWindows } from "@/lib/spend";
import { budgetReservations, projects, usageEvents } from "./schema";

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
  return row;
}
