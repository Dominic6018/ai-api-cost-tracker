import { and, desc, eq, lte } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import {
  selectEffectivePricing,
  type PricingLookupResult,
} from "@/lib/pricing";
import { modelPricing, type ModelPricing } from "./schema";

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
