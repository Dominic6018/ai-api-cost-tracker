import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { csvRow } from "@/lib/csv";
import type { UsageFilters } from "@/lib/usage-filters";
import { listUsageEvents, type UsageEventRow } from "./usage-events";

/** Any Drizzle Postgres database, so callers and tests can pass their own. */
type Database = Pick<PgDatabase<PgQueryResultHKT>, "select" | "selectDistinct">;

export const USAGE_CSV_COLUMNS = [
  "occurred_at",
  "project",
  "provider",
  "model",
  "input_tokens",
  "cached_input_tokens",
  "cache_write_input_tokens",
  "cache_write_1h_input_tokens",
  "service_tier",
  "web_search_requests",
  "audio_input_tokens",
  "cached_audio_input_tokens",
  "audio_output_tokens",
  "image_input_tokens",
  "cached_image_input_tokens",
  "image_output_tokens",
  "output_tokens",
  "cost_usd",
  "customer_id",
  "user_id",
  "feature",
  "run_id",
  "tags",
  "request_id",
] as const;

/** Rows fetched per query; the export streams them as it goes. */
const EXPORT_PAGE_SIZE = 1000;

function line(row: UsageEventRow): string {
  return csvRow([
    row.occurredAt.toISOString(),
    row.projectName,
    row.provider,
    row.model,
    row.inputTokens,
    row.cachedInputTokens,
    row.cacheWriteInputTokens,
    row.cacheWrite1hInputTokens,
    row.serviceTier,
    row.webSearchRequests,
    row.audioInputTokens,
    row.cachedAudioInputTokens,
    row.audioOutputTokens,
    row.imageInputTokens,
    row.cachedImageInputTokens,
    row.imageOutputTokens,
    row.outputTokens,
    // Exact decimal string, as stored; not converted through a float.
    row.costUsd,
    row.customerId,
    row.userId,
    row.feature,
    row.runId,
    // A JSON object, quoted as one cell.
    row.tags ? JSON.stringify(row.tags) : null,
    row.requestId,
  ]);
}

/**
 * Every usage event matching `filters`, newest first, as CSV text chunks:
 * the header, then one chunk per page. Pages use the usage list's keyset
 * pagination, so memory stays flat however many events there are.
 */
export async function* usageCsv(
  db: Database,
  filters: Omit<UsageFilters, "cursor">,
  pageSize = EXPORT_PAGE_SIZE,
): AsyncGenerator<string> {
  yield csvRow(USAGE_CSV_COLUMNS);
  let cursor: UsageFilters["cursor"];
  do {
    const page = await listUsageEvents(db, { ...filters, cursor }, pageSize);
    if (page.rows.length > 0) yield page.rows.map(line).join("");
    cursor = page.next;
  } while (cursor);
}
