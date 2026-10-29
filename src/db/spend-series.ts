import { and, eq, gte, sql, type SQL } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { DailySpend } from "@/lib/spend-series";
import { usageEvents } from "./schema";

/** Any Drizzle Postgres database, so callers and tests can pass their own. */
type Database = Pick<PgDatabase<PgQueryResultHKT>, "select">;

export interface SpendFilter {
  /** Usage at or after this time is included. */
  start: Date;
  /** Limit to one project; all projects when omitted. */
  projectId?: string;
}

/** Spend, token and event totals as decimal strings, so sums stay exact. */
export interface BreakdownRow {
  provider: string;
  /** Set on the per-model breakdown only. */
  model?: string;
  costUsd: string;
  inputTokens: string;
  outputTokens: string;
  cachedInputTokens: string;
  events: number;
}

function where({ start, projectId }: SpendFilter): SQL | undefined {
  // gte() maps the Date through the column; raw sql templates would not.
  return and(
    gte(usageEvents.occurredAt, start),
    projectId ? eq(usageEvents.projectId, projectId) : undefined,
  );
}

const utcDay = sql<string>`to_char(${usageEvents.occurredAt} at time zone 'UTC', 'YYYY-MM-DD')`;
const costSum = sql`sum(${usageEvents.costUsd})`;
const totals = {
  costUsd: sql<string>`${costSum}::numeric(14, 6)::text`,
  inputTokens: sql<string>`sum(${usageEvents.inputTokens})::text`,
  outputTokens: sql<string>`sum(${usageEvents.outputTokens})::text`,
  cachedInputTokens: sql<string>`sum(${usageEvents.cachedInputTokens})::text`,
  events: sql<number>`count(*)::int`,
};

/** Spend per UTC day; days without usage are omitted (see fillDailySeries). */
export async function getDailySpend(
  db: Database,
  filter: SpendFilter,
): Promise<DailySpend[]> {
  return db
    .select({ day: utcDay, costUsd: totals.costUsd })
    .from(usageEvents)
    .where(where(filter))
    .groupBy(utcDay)
    .orderBy(utcDay);
}

/** Totals per provider and per provider/model, highest spend first. */
export async function getSpendBreakdown(
  db: Database,
  filter: SpendFilter,
): Promise<{ byProvider: BreakdownRow[]; byModel: BreakdownRow[] }> {
  const [byProvider, byModel] = await Promise.all([
    db
      .select({ provider: usageEvents.provider, ...totals })
      .from(usageEvents)
      .where(where(filter))
      .groupBy(usageEvents.provider)
      // Order by the numeric sum, not its text form.
      .orderBy(sql`${costSum} desc`, usageEvents.provider),
    db
      .select({
        provider: usageEvents.provider,
        model: usageEvents.model,
        ...totals,
      })
      .from(usageEvents)
      .where(where(filter))
      .groupBy(usageEvents.provider, usageEvents.model)
      .orderBy(sql`${costSum} desc`, usageEvents.provider, usageEvents.model),
  ]);
  return { byProvider, byModel };
}
