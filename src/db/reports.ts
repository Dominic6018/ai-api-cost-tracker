import { and, asc, desc, eq, gte, lt, sql, type SQL } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { ATTRIBUTION_FIELDS } from "@/lib/attribution";
import { MAX_REPORT_GROUPS, type SpendGroup } from "@/lib/reports";
import { usageEvents } from "./schema";

/** Any Drizzle Postgres database, so callers and tests can pass their own. */
type Database = Pick<PgDatabase<PgQueryResultHKT>, "select">;

/** Sums as exact decimal strings, so no amount passes through a float. */
export interface SpendTotals {
  costUsd: string;
  requests: number;
  inputTokens: string;
  cachedInputTokens: string;
  cacheWriteInputTokens: string;
  outputTokens: string;
}

export interface SpendReport {
  totals: SpendTotals;
  /** `key` is the day, provider, model or attribution value; null is unset. */
  groups: (SpendTotals & { key: string | null })[];
  /** True when there were more than MAX_REPORT_GROUPS groups. */
  truncated: boolean;
}

const utcDay = sql<string>`to_char(${usageEvents.occurredAt} at time zone 'UTC', 'YYYY-MM-DD')`;

function groupColumn(groupBy: SpendGroup): SQL<string | null> {
  if (groupBy === "day") return utcDay;
  if (groupBy === "provider") return sql`${usageEvents.provider}::text`;
  if (groupBy === "model") return sql`${usageEvents.model}`;
  const field = ATTRIBUTION_FIELDS.find((f) => f.param === groupBy)!;
  return sql`${usageEvents[field.key]}`;
}

const costSum = sql`coalesce(sum(${usageEvents.costUsd}), 0)`;
const sums = {
  costUsd: sql<string>`${costSum}::numeric(14, 6)::text`,
  requests: sql<number>`count(*)::int`,
  inputTokens: sql<string>`coalesce(sum(${usageEvents.inputTokens}), 0)::text`,
  cachedInputTokens: sql<string>`coalesce(sum(${usageEvents.cachedInputTokens}), 0)::text`,
  cacheWriteInputTokens: sql<string>`coalesce(sum(${usageEvents.cacheWriteInputTokens}), 0)::text`,
  outputTokens: sql<string>`coalesce(sum(${usageEvents.outputTokens}), 0)::text`,
};

/**
 * One project's spend in `[start, end)`, grouped. Days are listed in
 * order; every other grouping is listed by cost, highest first.
 */
export async function getSpendReport(
  db: Database,
  {
    projectId,
    start,
    end,
    groupBy,
  }: { projectId: string; start: Date; end: Date; groupBy: SpendGroup },
): Promise<SpendReport> {
  const where = and(
    eq(usageEvents.projectId, projectId),
    gte(usageEvents.occurredAt, start),
    lt(usageEvents.occurredAt, end),
  );
  const key = groupColumn(groupBy);
  const [[totals], rows] = await Promise.all([
    db.select(sums).from(usageEvents).where(where),
    db
      .select({ key, ...sums })
      .from(usageEvents)
      .where(where)
      .groupBy(key)
      .orderBy(
        ...(groupBy === "day"
          ? [asc(key)]
          : [desc(costSum), sql`${key} asc nulls last`]),
      )
      // One extra row says whether the groups were cut off.
      .limit(MAX_REPORT_GROUPS + 1),
  ]);
  return {
    totals,
    groups: rows.slice(0, MAX_REPORT_GROUPS),
    truncated: rows.length > MAX_REPORT_GROUPS,
  };
}
