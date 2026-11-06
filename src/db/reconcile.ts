import { and, eq, gte, lt, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { toMicros } from "@/lib/budget";
import type { RecordedCost } from "@/lib/reconcile";
import { usageEvents, type Provider } from "./schema";

/** Any Drizzle Postgres database, so callers and tests can pass their own. */
type Database = Pick<PgDatabase<PgQueryResultHKT>, "select">;

const utcDay = sql<string>`to_char(${usageEvents.occurredAt} at time zone 'UTC', 'YYYY-MM-DD')`;

/**
 * Recorded cost per UTC day and model for one provider, across every
 * project, for usage in `[from, to)`: token cost and web search cost apart,
 * as providers bill them. Sums are exact decimals.
 */
export async function recordedDailyCost(
  db: Database,
  { provider, from, to }: { provider: Provider; from: Date; to: Date },
): Promise<RecordedCost[]> {
  const rows = await db
    .select({
      day: utcDay,
      model: usageEvents.model,
      costUsd: sql<string>`sum(${usageEvents.costUsd} - ${usageEvents.webSearchCostUsd})::numeric(14, 6)::text`,
      webSearchCostUsd: sql<string>`sum(${usageEvents.webSearchCostUsd})::numeric(14, 6)::text`,
    })
    .from(usageEvents)
    .where(
      and(
        eq(usageEvents.provider, provider),
        gte(usageEvents.occurredAt, from),
        lt(usageEvents.occurredAt, to),
      ),
    )
    .groupBy(utcDay, usageEvents.model)
    .orderBy(utcDay, usageEvents.model);
  return rows.map((row) => ({
    day: row.day,
    model: row.model,
    micros: toMicros(row.costUsd),
    webSearchMicros: toMicros(row.webSearchCostUsd),
  }));
}
