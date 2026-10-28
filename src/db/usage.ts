import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { calculateCostUsd } from "@/lib/cost";
import type { UsageInput } from "@/lib/usage";
import { findEffectivePricing } from "./pricing";
import { usageEvents, type UsageEvent } from "./schema";

/** Any Drizzle Postgres database, so callers and tests can pass their own. */
type Database = Pick<PgDatabase<PgQueryResultHKT>, "select" | "insert">;

export type RecordUsageResult =
  | { ok: true; event: UsageEvent }
  | {
      ok: false;
      error: "no_pricing" | "project_not_found" | "duplicate_request";
    };

const FOREIGN_KEY_VIOLATION = "23503";
const UNIQUE_VIOLATION = "23505";

/** Postgres SQLSTATE of a failed query; drizzle wraps driver errors in `cause`. */
function pgErrorCode(error: unknown): string | undefined {
  const cause = (error as { cause?: unknown })?.cause ?? error;
  const code = (cause as { code?: unknown })?.code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Prices a usage record with the rate in effect when it occurred and stores
 * it. Expected failures come back as typed errors; anything else throws.
 */
export async function recordUsage(
  db: Database,
  usage: UsageInput,
): Promise<RecordUsageResult> {
  const lookup = await findEffectivePricing(db, {
    provider: usage.provider,
    model: usage.model,
    at: usage.occurredAt,
  });
  if (!lookup.found) return { ok: false, error: "no_pricing" };

  const costUsd = calculateCostUsd(usage, lookup.pricing);

  try {
    const [event] = await db
      .insert(usageEvents)
      .values({
        projectId: usage.projectId,
        provider: usage.provider,
        model: usage.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cachedInputTokens: usage.cachedInputTokens,
        costUsd: costUsd.toFixed(6),
        requestId: usage.requestId ?? null,
        occurredAt: usage.occurredAt,
        metadata: usage.metadata ?? null,
      })
      .returning();
    return { ok: true, event };
  } catch (error) {
    const code = pgErrorCode(error);
    if (code === FOREIGN_KEY_VIOLATION) {
      return { ok: false, error: "project_not_found" };
    }
    if (code === UNIQUE_VIOLATION) {
      return { ok: false, error: "duplicate_request" };
    }
    throw error;
  }
}
