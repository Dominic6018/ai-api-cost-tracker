import { and, eq } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { microsToDecimal } from "@/lib/budget";
import { calculateCostMicros, hasAudio, webSearchCostMicros } from "@/lib/cost";
import { priceTierFor } from "@/lib/pricing";
import type { UsageInput } from "@/lib/usage";
import { endReservation } from "./budget-reservations";
import { findEffectivePricing } from "./pricing";
import { usageEvents, type UnpricedReason, type UsageEvent } from "./schema";

/** Any Drizzle Postgres database, so callers and tests can pass their own. */
type Database = Pick<
  PgDatabase<PgQueryResultHKT>,
  "select" | "insert" | "update"
>;

export type RecordUsageResult =
  | {
      ok: true;
      event: UsageEvent;
      /** True when the request repeated an already stored event. */
      replayed: boolean;
    }
  | {
      ok: false;
      error: "project_not_found" | "request_id_conflict";
    };

/** What pricing needs from a usage record. */
export type PricedFields = Omit<UsageInput, "projectId" | "requestId"> & {
  requestId?: string;
};

export type PriceResult =
  | { ok: true; costMicros: bigint; searchMicros: bigint }
  | { ok: false; reason: UnpricedReason };

/**
 * Prices usage with the rates in effect when it occurred. Each missing
 * price is a reason, not an error: the caller stores the usage as
 * unpriced, never at a wrong price.
 */
export async function priceUsage(
  db: Pick<Database, "select">,
  usage: PricedFields,
): Promise<PriceResult> {
  const tier = priceTierFor(usage.serviceTier);
  const lookup = await findEffectivePricing(db, {
    provider: usage.provider,
    model: usage.model,
    at: usage.occurredAt,
    serviceTier: tier,
  });
  if (!lookup.found) {
    // A flex or fast request is never billed at the standard price.
    return {
      ok: false,
      reason: tier === "standard" ? "no_pricing" : "no_tier_pricing",
    };
  }
  if (usage.serviceTier === "batch" && lookup.pricing.batchMultiplier == null) {
    return { ok: false, reason: "no_batch_pricing" };
  }
  // Searches are charged on top of tokens; without a price they'd be
  // recorded as free.
  const searchPrice = lookup.row.webSearchPer1kUsd;
  if (usage.webSearchRequests > 0 && searchPrice === null) {
    return { ok: false, reason: "no_web_search_pricing" };
  }
  // Audio tokens are billed at audio rates; without them they'd be
  // billed as (much cheaper) text.
  if (hasAudio(usage) && !lookup.pricing.audio) {
    return { ok: false, reason: "no_audio_pricing" };
  }
  const searchMicros =
    usage.webSearchRequests > 0 && searchPrice !== null
      ? webSearchCostMicros(usage.webSearchRequests, searchPrice)
      : 0n;
  return {
    ok: true,
    costMicros: calculateCostMicros(usage, lookup.pricing) + searchMicros,
    searchMicros,
  };
}

/** The stored cost columns for a pricing result. */
export function costColumns(price: PriceResult) {
  return price.ok
    ? {
        costUsd: microsToDecimal(price.costMicros),
        webSearchCostUsd: microsToDecimal(price.searchMicros),
        pricingStatus: "priced" as const,
        unpricedReason: null,
      }
    : {
        costUsd: null,
        webSearchCostUsd: "0",
        pricingStatus: "unpriced" as const,
        unpricedReason: price.reason,
      };
}

const FOREIGN_KEY_VIOLATION = "23503";
const UNIQUE_VIOLATION = "23505";

/** Postgres SQLSTATE of a failed query; drizzle wraps driver errors in `cause`. */
function pgErrorCode(error: unknown): string | undefined {
  const cause = (error as { cause?: unknown })?.cause ?? error;
  const code = (cause as { code?: unknown })?.code;
  return typeof code === "string" ? code : undefined;
}

/**
 * A request id identifies an event within one project: two projects, even
 * in different organizations, can't block or detect each other's events.
 */
async function findByRequestId(
  db: Database,
  { projectId, provider, requestId }: UsageInput & { requestId: string },
): Promise<UsageEvent | undefined> {
  const [event] = await db
    .select()
    .from(usageEvents)
    .where(
      and(
        eq(usageEvents.projectId, projectId),
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
 * `occurredAt`, `metadata`, attribution and tags aren't compared, since retries
 * that omit `occurredAt` default it to the time of each attempt.
 */
function replay(existing: UsageEvent, usage: UsageInput): RecordUsageResult {
  const sameUsage =
    existing.projectId === usage.projectId &&
    existing.model === usage.model &&
    existing.inputTokens === usage.inputTokens &&
    existing.outputTokens === usage.outputTokens &&
    existing.cachedInputTokens === usage.cachedInputTokens &&
    existing.cacheWriteInputTokens === usage.cacheWriteInputTokens &&
    existing.cacheWrite1hInputTokens === usage.cacheWrite1hInputTokens &&
    existing.serviceTier === usage.serviceTier &&
    existing.webSearchRequests === usage.webSearchRequests &&
    existing.audioInputTokens === usage.audioInputTokens &&
    existing.cachedAudioInputTokens === usage.cachedAudioInputTokens &&
    existing.audioOutputTokens === usage.audioOutputTokens &&
    existing.imageInputTokens === usage.imageInputTokens &&
    existing.cachedImageInputTokens === usage.cachedImageInputTokens &&
    existing.imageOutputTokens === usage.imageOutputTokens;
  return sameUsage
    ? { ok: true, event: existing, replayed: true }
    : { ok: false, error: "request_id_conflict" };
}

/**
 * Prices a usage record with the rate in effect when it occurred and stores
 * it, as unpriced when a price is missing, and settles the reservation it
 * names. Repeating a `(provider, requestId)` in the same project returns the
 * stored event instead of inserting another. Expected failures come back as
 * typed errors; anything else throws.
 */
export async function recordUsage(
  db: Database,
  usage: UsageInput,
): Promise<RecordUsageResult> {
  const result = await storeUsage(db, usage);
  // Recorded usage replaces the hold it was reserved under. Settled after
  // the insert, so a crash in between leaves the hold until it expires:
  // briefly counted twice, never not at all. A retry settles it too.
  if (result.ok && usage.reservationId !== undefined) {
    await endReservation(db, {
      projectId: usage.projectId,
      reservationId: usage.reservationId,
      status: "settled",
    });
  }
  return result;
}

async function storeUsage(
  db: Database,
  usage: UsageInput,
): Promise<RecordUsageResult> {
  // Replay before pricing, so a retry gets its original event even if the
  // price has changed since.
  if (usage.requestId !== undefined) {
    const existing = await findByRequestId(db, {
      ...usage,
      requestId: usage.requestId,
    });
    if (existing) return replay(existing, usage);
  }

  // Usage without a price is kept as unpriced, to be priced later.
  const price = await priceUsage(db, usage);

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
        cacheWriteInputTokens: usage.cacheWriteInputTokens,
        cacheWrite1hInputTokens: usage.cacheWrite1hInputTokens,
        serviceTier: usage.serviceTier,
        ...costColumns(price),
        webSearchRequests: usage.webSearchRequests,
        audioInputTokens: usage.audioInputTokens,
        cachedAudioInputTokens: usage.cachedAudioInputTokens,
        audioOutputTokens: usage.audioOutputTokens,
        imageInputTokens: usage.imageInputTokens,
        cachedImageInputTokens: usage.cachedImageInputTokens,
        imageOutputTokens: usage.imageOutputTokens,
        requestId: usage.requestId ?? null,
        occurredAt: usage.occurredAt,
        metadata: usage.metadata ?? null,
        customerId: usage.customerId ?? null,
        userId: usage.userId ?? null,
        feature: usage.feature ?? null,
        runId: usage.runId ?? null,
        tags: usage.tags ?? null,
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
      const existing = await findByRequestId(db, {
        ...usage,
        requestId: usage.requestId,
      });
      if (existing) return replay(existing, usage);
    }
    throw error;
  }
}
