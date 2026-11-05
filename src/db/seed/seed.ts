import { sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { modelPricing, projects } from "../schema";
import { sampleProjects, seedPrices } from "./data";

/** Any Drizzle Postgres database, so the CLI and tests can pass their own. */
type Database = Pick<PgDatabase<PgQueryResultHKT>, "insert">;

export interface SeedResult {
  projectsInserted: number;
  pricesInserted: number;
  /**
   * Existing prices given the source, check date or 1-hour cache-write
   * rates they were missing.
   */
  filled: number;
}

/**
 * Inserts sample projects and seed prices. Safe to re-run: rows that
 * already exist (by project slug, or by provider, model and start time)
 * keep their values. The one exception: an existing price recorded
 * without a source, a check date or a 1-hour cache-write rate the seed
 * has gets the seed's, filling only what's missing, so databases seeded
 * before those columns existed catch up. Recorded values aren't changed.
 */
export async function seed(db: Database): Promise<SeedResult> {
  const insertedProjects = await db
    .insert(projects)
    .values(sampleProjects)
    .onConflictDoNothing({ target: projects.slug })
    .returning({ id: projects.id });

  const upsertedPrices = await db
    .insert(modelPricing)
    .values(
      seedPrices.map((price) => ({
        provider: price.provider,
        model: price.model,
        inputPerMTokUsd: price.inputPerMTokUsd,
        outputPerMTokUsd: price.outputPerMTokUsd,
        cachedInputPerMTokUsd: price.cachedInputPerMTokUsd,
        cacheWritePerMTokUsd: price.cacheWritePerMTokUsd ?? null,
        cacheWrite1hPerMTokUsd: price.cacheWrite1hPerMTokUsd ?? null,
        longContextThresholdTokens: price.longContext?.thresholdTokens ?? null,
        longInputPerMTokUsd: price.longContext?.inputPerMTokUsd ?? null,
        longOutputPerMTokUsd: price.longContext?.outputPerMTokUsd ?? null,
        longCachedInputPerMTokUsd:
          price.longContext?.cachedInputPerMTokUsd ?? null,
        longCacheWritePerMTokUsd:
          price.longContext?.cacheWritePerMTokUsd ?? null,
        longCacheWrite1hPerMTokUsd:
          price.longContext?.cacheWrite1hPerMTokUsd ?? null,
        effectiveFrom: new Date(price.effectiveFrom),
        effectiveTo: price.effectiveTo ? new Date(price.effectiveTo) : null,
        sourceUrl: price.source,
        checkedOn: price.checkedOn,
      })),
    )
    .onConflictDoUpdate({
      target: [
        modelPricing.provider,
        modelPricing.model,
        modelPricing.effectiveFrom,
      ],
      // Fill in what's missing only; recorded values are kept. A 1-hour
      // rate counts as missing only when the seed has one, so models
      // without one (OpenAI, Google) aren't rewritten on every run.
      set: {
        sourceUrl: sql`coalesce(${modelPricing.sourceUrl}, excluded.source_url)`,
        checkedOn: sql`coalesce(${modelPricing.checkedOn}, excluded.checked_on)`,
        cacheWrite1hPerMTokUsd: sql`coalesce(${modelPricing.cacheWrite1hPerMTokUsd}, excluded.cache_write_1h_per_mtok_usd)`,
        longCacheWrite1hPerMTokUsd: sql`coalesce(${modelPricing.longCacheWrite1hPerMTokUsd}, excluded.long_cache_write_1h_per_mtok_usd)`,
      },
      setWhere: sql`${modelPricing.sourceUrl} is null or ${modelPricing.checkedOn} is null or (${modelPricing.cacheWrite1hPerMTokUsd} is null and excluded.cache_write_1h_per_mtok_usd is not null) or (${modelPricing.longCacheWrite1hPerMTokUsd} is null and excluded.long_cache_write_1h_per_mtok_usd is not null)`,
    })
    // xmax is 0 for a row this statement inserted, and set for one it updated.
    .returning({ inserted: sql<boolean>`(xmax = 0)` });

  const pricesInserted = upsertedPrices.filter((row) => row.inserted).length;
  return {
    projectsInserted: insertedProjects.length,
    pricesInserted,
    filled: upsertedPrices.length - pricesInserted,
  };
}
