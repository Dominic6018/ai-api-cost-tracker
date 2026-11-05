import { and, asc, desc, eq, gt, isNull, lt, lte, or } from "drizzle-orm";
import {
  alias,
  type PgDatabase,
  type PgQueryResultHKT,
} from "drizzle-orm/pg-core";
import {
  selectEffectivePricing,
  type PricingLookupResult,
} from "@/lib/pricing";
import type { EndPriceInput } from "@/lib/price-end-form";
import type { PriceInput } from "@/lib/price-form";
import { modelPricing, users, type ModelPricing } from "./schema";

type Provider = ModelPricing["provider"];

/** Any Drizzle Postgres database, so callers and tests can pass their own. */
type Database = Pick<PgDatabase<PgQueryResultHKT>, "select">;

export interface PricingLookup {
  provider: Provider;
  model: string;
  at: Date;
}

/**
 * Finds the `model_pricing` row in effect for a model at a point in time.
 * SQL narrows to prices that started on or before `at`; the range check on
 * `effective_to` lives in `selectEffectivePricing` so it is defined once.
 */
export async function findEffectivePricing(
  db: Database,
  { provider, model, at }: PricingLookup,
): Promise<PricingLookupResult<ModelPricing>> {
  const candidates = await db
    .select()
    .from(modelPricing)
    .where(
      and(
        eq(modelPricing.provider, provider),
        eq(modelPricing.model, model),
        lte(modelPricing.effectiveFrom, at),
      ),
    )
    .orderBy(desc(modelPricing.effectiveFrom));

  return selectEffectivePricing(candidates, at);
}

/** A price row for the list, with the emails of who added and ended it. */
export type PriceListEntry = ModelPricing & {
  recordedByEmail: string | null;
  endedByEmail: string | null;
};

const recorder = alias(users, "recorder");
const ender = alias(users, "ender");

/** Every price row, for the price list; grouping happens in `priceHistories`. */
export async function listModelPrices(db: Database): Promise<PriceListEntry[]> {
  const rows = await db
    .select({
      price: modelPricing,
      recordedByEmail: recorder.email,
      endedByEmail: ender.email,
    })
    .from(modelPricing)
    .leftJoin(recorder, eq(recorder.id, modelPricing.recordedBy))
    .leftJoin(ender, eq(ender.id, modelPricing.endedBy))
    .orderBy(
      asc(modelPricing.provider),
      asc(modelPricing.model),
      desc(modelPricing.effectiveFrom),
    );
  return rows.map(({ price, recordedByEmail, endedByEmail }) => ({
    ...price,
    recordedByEmail,
    endedByEmail,
  }));
}

const UNIQUE_VIOLATION = "23505";

function pgErrorCode(error: unknown): string | undefined {
  const cause = (error as { cause?: unknown })?.cause ?? error;
  const code = (cause as { code?: unknown })?.code;
  return typeof code === "string" ? code : undefined;
}

export type AddPriceResult =
  | {
      ok: true;
      price: ModelPricing;
      /** Earlier prices for the model that now end where this one starts. */
      ended: number;
    }
  | { ok: false; error: "duplicate_start" };

/**
 * Adds a price from the price screen, in one transaction:
 *
 * - earlier prices for the model that would still apply at its start are
 *   ended there, so the history reads as one price after another;
 * - if a later price is already scheduled, the new one ends where that
 *   one starts, so ranges never overlap;
 * - recorded usage keeps its stored cost; the price applies to usage
 *   recorded from now on.
 *
 * A price that starts at the same time as an existing one for the model
 * is refused, and nothing changes.
 */
export async function addModelPrice<
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
>(
  // Generic, so both the app's schema-aware database and plain ones fit.
  db: Pick<PgDatabase<TQueryResult, TFullSchema>, "transaction">,
  input: PriceInput,
  recordedBy: string,
): Promise<AddPriceResult> {
  const sameModel = and(
    eq(modelPricing.provider, input.provider),
    eq(modelPricing.model, input.model),
  );
  try {
    return await db.transaction(async (tx) => {
      const [next] = await tx
        .select({ effectiveFrom: modelPricing.effectiveFrom })
        .from(modelPricing)
        .where(
          and(sameModel, gt(modelPricing.effectiveFrom, input.effectiveFrom)),
        )
        .orderBy(asc(modelPricing.effectiveFrom))
        .limit(1);

      const ended = await tx
        .update(modelPricing)
        .set({ effectiveTo: input.effectiveFrom })
        .where(
          and(
            sameModel,
            lt(modelPricing.effectiveFrom, input.effectiveFrom),
            or(
              isNull(modelPricing.effectiveTo),
              gt(modelPricing.effectiveTo, input.effectiveFrom),
            ),
          ),
        )
        .returning({ id: modelPricing.id });

      const [price] = await tx
        .insert(modelPricing)
        .values({
          ...input,
          effectiveTo: next?.effectiveFrom ?? null,
          recordedBy,
        })
        .returning();
      return { ok: true as const, price, ended: ended.length };
    });
  } catch (error) {
    if (pgErrorCode(error) === UNIQUE_VIOLATION) {
      return { ok: false, error: "duplicate_start" };
    }
    throw error;
  }
}

const INVALID_TEXT_REPRESENTATION = "22P02";

/** One price by id; undefined for unknown or malformed ids. */
export async function getModelPrice(
  db: Database,
  id: string,
): Promise<ModelPricing | undefined> {
  try {
    const [price] = await db
      .select()
      .from(modelPricing)
      .where(eq(modelPricing.id, id));
    return price;
  } catch (error) {
    if (pgErrorCode(error) === INVALID_TEXT_REPRESENTATION) return undefined;
    throw error;
  }
}

export type EndPriceResult =
  | { ok: true; price: ModelPricing }
  | {
      ok: false;
      /**
       * not_found: no such price. invalid_end: the end isn't after the
       * price's start and before any end it already has.
       */
      error: "not_found" | "invalid_end";
    };

/**
 * Ends a price without a replacement, e.g. for a retired model, recording
 * where that was read, when it was checked and who did it. It can only
 * shorten a price: the end must be after its start and before any end it
 * already has. One conditional update, so a price changed in the meantime
 * is refused rather than overwritten.
 */
export async function endModelPrice(
  db: Pick<PgDatabase<PgQueryResultHKT>, "select" | "update">,
  id: string,
  input: EndPriceInput,
  endedBy: string,
): Promise<EndPriceResult> {
  try {
    const [price] = await db
      .update(modelPricing)
      .set({
        effectiveTo: input.endsAt,
        endSourceUrl: input.sourceUrl,
        endCheckedOn: input.checkedOn,
        endedBy,
      })
      .where(
        and(
          eq(modelPricing.id, id),
          lt(modelPricing.effectiveFrom, input.endsAt),
          or(
            isNull(modelPricing.effectiveTo),
            gt(modelPricing.effectiveTo, input.endsAt),
          ),
        ),
      )
      .returning();
    if (price) return { ok: true, price };
  } catch (error) {
    if (pgErrorCode(error) === INVALID_TEXT_REPRESENTATION) {
      return { ok: false, error: "not_found" };
    }
    throw error;
  }
  return (await getModelPrice(db, id))
    ? { ok: false, error: "invalid_end" }
    : { ok: false, error: "not_found" };
}
