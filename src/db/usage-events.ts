import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import {
  dateBounds,
  USAGE_PAGE_SIZE,
  type UsageCursor,
  type UsageFilters,
} from "@/lib/usage-filters";
import { projects, usageEvents, type Provider } from "./schema";

/** Any Drizzle Postgres database, so callers and tests can pass their own. */
type Database = Pick<PgDatabase<PgQueryResultHKT>, "select" | "selectDistinct">;

export interface UsageEventRow {
  id: string;
  occurredAt: Date;
  projectId: string;
  projectName: string;
  provider: Provider;
  model: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costUsd: string;
  requestId: string | null;
}

export interface UsageEventsPage {
  rows: UsageEventRow[];
  /** Cursor for the next (older) page; undefined on the last page. */
  next?: UsageCursor;
}

// occurred_at with full microsecond precision. A JS Date only keeps
// milliseconds, so a cursor built from one could skip or repeat rows.
const exactOccurredAt = sql<string>`to_char(${usageEvents.occurredAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/**
 * Query for one page of usage events (plus one row to detect a next page),
 * newest first, using keyset pagination on
 * (occurred_at, id). The id breaks ties between events with the same
 * timestamp, so paging never skips or repeats a row. Filtering by project
 * uses the (project_id, occurred_at) index; otherwise (occurred_at).
 */
export function usageEventsQuery(
  db: Database,
  filters: UsageFilters,
  pageSize: number,
) {
  const { start, end } = dateBounds(filters);
  const { cursor } = filters;

  return (
    db
      .select({
        id: usageEvents.id,
        occurredAt: usageEvents.occurredAt,
        exactOccurredAt,
        projectId: usageEvents.projectId,
        projectName: projects.name,
        provider: usageEvents.provider,
        model: usageEvents.model,
        inputTokens: usageEvents.inputTokens,
        cachedInputTokens: usageEvents.cachedInputTokens,
        outputTokens: usageEvents.outputTokens,
        costUsd: usageEvents.costUsd,
        requestId: usageEvents.requestId,
      })
      .from(usageEvents)
      .innerJoin(projects, eq(projects.id, usageEvents.projectId))
      .where(
        and(
          filters.projectId
            ? eq(usageEvents.projectId, filters.projectId)
            : undefined,
          filters.provider
            ? eq(usageEvents.provider, filters.provider)
            : undefined,
          filters.model ? eq(usageEvents.model, filters.model) : undefined,
          start ? gte(usageEvents.occurredAt, start) : undefined,
          end ? lt(usageEvents.occurredAt, end) : undefined,
          // Row comparison: strictly older than the cursor, ties broken by id.
          // Values are passed as text; raw sql parameters skip Date mapping.
          cursor
            ? sql`(${usageEvents.occurredAt}, ${usageEvents.id}) < (${cursor.occurredAt}::timestamptz, ${cursor.id}::uuid)`
            : undefined,
        ),
      )
      .orderBy(desc(usageEvents.occurredAt), desc(usageEvents.id))
      // One extra row tells us whether there's another page.
      .limit(pageSize + 1)
  );
}

export async function listUsageEvents(
  db: Database,
  filters: UsageFilters,
  pageSize: number = USAGE_PAGE_SIZE,
): Promise<UsageEventsPage> {
  const rows = await usageEventsQuery(db, filters, pageSize);
  const page = rows.slice(0, pageSize);
  const last = page.at(-1);
  return {
    // Drop the cursor-only column from the returned rows.
    rows: page.map((row) => {
      const { exactOccurredAt, ...rest } = row;
      void exactOccurredAt;
      return rest;
    }),
    next:
      rows.length > pageSize && last
        ? { occurredAt: last.exactOccurredAt, id: last.id }
        : undefined,
  };
}

/** Distinct models seen, for the model filter's suggestions. */
export async function listUsageModels(db: Database): Promise<string[]> {
  const rows = await db
    .selectDistinct({ model: usageEvents.model })
    .from(usageEvents)
    .orderBy(usageEvents.model)
    .limit(500);
  return rows.map((row) => row.model);
}
