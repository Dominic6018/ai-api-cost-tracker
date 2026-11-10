import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { AttributionKey } from "@/lib/attribution";
import type { BreakdownGroup } from "@/lib/breakdown";
import { usageEvents } from "./schema";
import { projectInOrganization, type OrganizationScope } from "./scope";

/** Any Drizzle Postgres database, so callers and tests can pass their own. */
type Database = Pick<PgDatabase<PgQueryResultHKT>, "select">;

export interface AttributionSpend {
  /** The most expensive groups, highest first; null is spend without a value. */
  top: BreakdownGroup[];
  totals: { costUsd: string; events: number; groups: number };
}

/**
 * Spend grouped by one attribution field since `start`, for one project or
 * all. Sums are exact decimals; totals cover every group, not just the top.
 */
export async function getSpendByAttribution(
  db: Database,
  scope: OrganizationScope,
  {
    key,
    start,
    projectId,
    limit,
  }: { key: AttributionKey; start: Date; projectId?: string; limit: number },
): Promise<AttributionSpend> {
  const column = usageEvents[key];
  const where = and(
    projectInOrganization(usageEvents.projectId, scope),
    gte(usageEvents.occurredAt, start),
    projectId ? eq(usageEvents.projectId, projectId) : undefined,
  );
  // Unpriced events have no cost; a group of only those sums to zero.
  const costSum = sql`coalesce(sum(${usageEvents.costUsd}), 0)`;
  const [top, [totals]] = await Promise.all([
    db
      .select({
        value: column,
        costUsd: sql<string>`${costSum}::numeric(14, 6)::text`,
        events: sql<number>`count(*)::int`,
      })
      .from(usageEvents)
      .where(where)
      .groupBy(column)
      // Order by the numeric sum, not its text form; ties by value.
      .orderBy(desc(costSum), sql`${column} nulls last`)
      .limit(limit),
    db
      .select({
        costUsd: sql<string>`coalesce(${costSum}, 0)::numeric(14, 6)::text`,
        events: sql<number>`count(*)::int`,
        // count(distinct) skips nulls, so count the "not set" group apart.
        groups: sql<number>`(count(distinct ${column}) + max(case when ${column} is null then 1 else 0 end))::int`,
      })
      .from(usageEvents)
      .where(where),
  ]);
  return {
    top,
    totals: {
      costUsd: totals.costUsd,
      events: totals.events,
      groups: totals.groups ?? 0,
    },
  };
}
