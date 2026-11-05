import { and, asc, desc, eq, gt, isNull, lt, lte, or } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import {
  selectEffectivePricing,
  type PricingLookupResult,
} from "@/lib/pricing";
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

/** A price row for the list, with the email of whoever added it. */
export type PriceListEntry = ModelPricing & { recordedByEmail: string | null };

/** Every price row, for the price list; grouping happens in `priceHistories`. */
export async function listModelPrices(db: Database): Promise<PriceListEntry[]> {
  const rows = await db
    .select({ price: modelPricing, recordedByEmail: users.email })
    .from(modelPricing)
    .leftJoin(users, eq(users.id, modelPricing.recordedBy))
    .orderBy(
      asc(modelPricing.provider),
      asc(modelPricing.model),
      desc(modelPricing.effectiveFrom),
    );
  return rows.map(({ price, recordedByEmail }) => ({
    ...price,
    recordedByEmail,
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
