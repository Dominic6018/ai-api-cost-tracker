import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { modelPricing, projects } from "../schema";
import { sampleProjects, seedPrices } from "./data";

/** Any Drizzle Postgres database, so the CLI and tests can pass their own. */
type Database = Pick<PgDatabase<PgQueryResultHKT>, "insert">;

export interface SeedResult {
  projectsInserted: number;
  pricesInserted: number;
}

/**
 * Inserts sample projects and seed prices. Safe to re-run: rows that
 * already exist (by project slug, or by provider, model and start time)
 * are left untouched rather than overwritten.
 */
export async function seed(db: Database): Promise<SeedResult> {
  const insertedProjects = await db
    .insert(projects)
    .values(sampleProjects)
    .onConflictDoNothing({ target: projects.slug })
    .returning({ id: projects.id });

  const insertedPrices = await db
    .insert(modelPricing)
    .values(
      seedPrices.map((price) => ({
        provider: price.provider,
        model: price.model,
        inputPerMTokUsd: price.inputPerMTokUsd,
        outputPerMTokUsd: price.outputPerMTokUsd,
        cachedInputPerMTokUsd: price.cachedInputPerMTokUsd,
        effectiveFrom: new Date(price.effectiveFrom),
        effectiveTo: price.effectiveTo ? new Date(price.effectiveTo) : null,
      })),
    )
    .onConflictDoNothing({
      target: [
        modelPricing.provider,
        modelPricing.model,
        modelPricing.effectiveFrom,
      ],
    })
    .returning({ id: modelPricing.id });

  return {
    projectsInserted: insertedProjects.length,
    pricesInserted: insertedPrices.length,
  };
}
