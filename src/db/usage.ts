import { and, eq } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { calculateCostUsd } from "@/lib/cost";
import type { UsageInput } from "@/lib/usage";
import { findEffectivePricing } from "./pricing";
import { usageEvents, type UsageEvent } from "./schema";

/** Any Drizzle Postgres database, so callers and tests can pass their own. */
type Database = Pick<PgDatabase<PgQueryResultHKT>, "select" | "insert">;

export type RecordUsageResult =
  | {
      ok: true;
      event: UsageEvent;
      /** True when the request repeated an already stored event. */
      replayed: boolean;
    }
  | {
      ok: false;
      error: "no_pricing" | "project_not_found" | "request_id_conflict";
    };

const FOREIGN_KEY_VIOLATION = "23503";
const UNIQUE_VIOLATION = "23505";

/** Postgres SQLSTATE of a failed query; drizzle wraps driver errors in `cause`. */
function pgErrorCode(error: unknown): string | undefined {
  const cause = (error as { cause?: unknown })?.cause ?? error;
  const code = (cause as { code?: unknown })?.code;
  return typeof code === "string" ? code : undefined;
}

async function findByRequestId(
  db: Database,
  provider: UsageInput["provider"],
  requestId: string,
): Promise<UsageEvent | undefined> {
  const [event] = await db
    .select()
    .from(usageEvents)
    .where(
      and(
        eq(usageEvents.provider, provider),
        eq(usageEvents.requestId, requestId),
      ),
    );
  return event;
}

/**
 * A stored event is only replayed to the project that recorded it, and only
 * when the retry describes the same usage. Anything else is a conflict:
 * returning it would leak another project's data or hide a client bug.
 * `occurredAt` and `metadata` aren't compared, since retries that omit
 * `occurredAt` default it to the time of each attempt.
 */
function replay(existing: UsageEvent, usage: UsageInput): RecordUsageResult {
  const sameUsage =
    existing.projectId === usage.projectId &&
    existing.model === usage.model &&
    existing.inputTokens === usage.inputTokens &&
    existing.outputTokens === usage.outputTokens &&
    existing.cachedInputTokens === usage.cachedInputTokens;
  return sameUsage
    ? { ok: true, event: existing, replayed: true }
    : { ok: false, error: "request_id_conflict" };
}

/**
 * Prices a usage record with the rate in effect when it occurred and stores
 * it. Repeating a `(provider, requestId)` returns the stored event instead
 * of inserting another. Expected failures come back as typed errors;
 * anything else throws.
 */
export async function recordUsage(
  db: Database,
  usage: UsageInput,
): Promise<RecordUsageResult> {
  // Replay before pricing, so a retry gets its original event even if the
  // price has changed since.
  if (usage.requestId !== undefined) {
    const existing = await findByRequestId(db, usage.provider, usage.requestId);
    if (existing) return replay(existing, usage);
  }

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
    return { ok: true, event, replayed: false };
  } catch (error) {
    const code = pgErrorCode(error);
    if (code === FOREIGN_KEY_VIOLATION) {
      return { ok: false, error: "project_not_found" };
    }
    // A concurrent request with the same id was inserted first; the unique
    // index decided the winner, so replay it.
    if (code === UNIQUE_VIOLATION && usage.requestId !== undefined) {
      const existing = await findByRequestId(
        db,
        usage.provider,
        usage.requestId,
      );
      if (existing) return replay(existing, usage);
    }
    throw error;
  }
}
