import "dotenv/config";
import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { parseEnv } from "@/lib/env";
import { findEffectivePricing } from "../pricing";
import { modelPricing, projects } from "../schema";
import { sampleProjects, seedPrices } from "./data";
import { seed } from "./seed";

// Runs against the database in DATABASE_URL after `npm run db:migrate`.
// Seed rows are left in place afterwards, as `npm run db:seed` would.
const client = postgres(parseEnv().DATABASE_URL, {
  max: 1,
  onnotice: () => {},
});
const db = drizzle(client);

afterAll(async () => {
  await client.end();
});

async function countSeedPrices() {
  const rows = await db
    .select({ id: modelPricing.id })
    .from(modelPricing)
    .where(
      inArray(
        modelPricing.model,
        seedPrices.map((p) => p.model),
      ),
    );
  return rows.length;
}

describe("seed", () => {
  it("inserts every seed row and is a no-op when re-run", async () => {
    await seed(db);
    expect(await countSeedPrices()).toBe(seedPrices.length);

    const rerun = await seed(db);
    expect(rerun).toEqual({
      projectsInserted: 0,
      pricesInserted: 0,
      filled: 0,
    });
    expect(await countSeedPrices()).toBe(seedPrices.length);
  });

  it("creates the sample projects", async () => {
    const rows = await db
      .select()
      .from(projects)
      .where(
        inArray(
          projects.slug,
          sampleProjects.map((p) => p.slug),
        ),
      );
    expect(rows).toHaveLength(sampleProjects.length);
  });

  it("does not overwrite an existing price", async () => {
    const [first] = seedPrices;
    const match = and(
      eq(modelPricing.provider, first.provider),
      eq(modelPricing.model, first.model),
      eq(modelPricing.effectiveFrom, new Date(first.effectiveFrom)),
    );
    const [before] = await db.select().from(modelPricing).where(match);

    await seed(db);

    const [after] = await db.select().from(modelPricing).where(match);
    expect(after).toEqual(before);
  });

  it("stores each price's source and check date", async () => {
    const rows = await db
      .select({
        model: modelPricing.model,
        effectiveFrom: modelPricing.effectiveFrom,
        sourceUrl: modelPricing.sourceUrl,
        checkedOn: modelPricing.checkedOn,
      })
      .from(modelPricing)
      .where(
        inArray(
          modelPricing.model,
          seedPrices.map((p) => p.model),
        ),
      );
    for (const price of seedPrices) {
      expect(
        rows.find(
          (row) =>
            row.model === price.model &&
            row.effectiveFrom.getTime() ===
              new Date(price.effectiveFrom).getTime(),
        ),
      ).toMatchObject({ sourceUrl: price.source, checkedOn: price.checkedOn });
    }
  });

  it("fills in missing provenance, keeping what's recorded and the price", async () => {
    const [first] = seedPrices;
    const match = and(
      eq(modelPricing.provider, first.provider),
      eq(modelPricing.model, first.model),
      eq(modelPricing.effectiveFrom, new Date(first.effectiveFrom)),
    );
    const row = async () =>
      (await db.select().from(modelPricing).where(match))[0];
    const before = await row();
    try {
      // A row seeded before the columns existed has neither.
      await db
        .update(modelPricing)
        .set({ sourceUrl: null, checkedOn: null })
        .where(match);
      expect(await seed(db)).toEqual({
        projectsInserted: 0,
        pricesInserted: 0,
        filled: 1,
      });
      expect(await row()).toMatchObject({
        sourceUrl: first.source,
        checkedOn: first.checkedOn,
        inputPerMTokUsd: before.inputPerMTokUsd,
        outputPerMTokUsd: before.outputPerMTokUsd,
      });

      // Only the date is missing: the recorded source stays.
      await db
        .update(modelPricing)
        .set({ sourceUrl: "https://example.com/own-check", checkedOn: null })
        .where(match);
      expect((await seed(db)).filled).toBe(1);
      expect(await row()).toMatchObject({
        sourceUrl: "https://example.com/own-check",
        checkedOn: first.checkedOn,
      });
    } finally {
      await db
        .update(modelPricing)
        .set({ sourceUrl: before.sourceUrl, checkedOn: before.checkedOn })
        .where(match);
    }
  });

  it("follows a scheduled price change through the pricing lookup", async () => {
    const before = await findEffectivePricing(db, {
      provider: "google",
      model: "gemini-3.8-flash",
      at: new Date("2026-12-31T23:59:59Z"),
    });
    const after = await findEffectivePricing(db, {
      provider: "google",
      model: "gemini-3.8-flash",
      at: new Date("2027-01-01T00:00:00Z"),
    });
    expect(before.found && before.pricing.inputPerMTokUsd).toBe(0.75);
    expect(after.found && after.pricing.inputPerMTokUsd).toBe(1.5);
  });

  it("stores a tiered price that the pricing lookup turns into a long tier", async () => {
    const result = await findEffectivePricing(db, {
      provider: "anthropic",
      model: "claude-haiku-5-5",
      at: new Date("2026-11-01T00:00:00Z"),
    });
    if (!result.found) throw new Error("expected pricing");
    expect(result.pricing.cacheWritePerMTokUsd).toBe(0.125);
    expect(result.pricing.longContext).toEqual({
      thresholdTokens: 100_000,
      inputPerMTokUsd: 0.5,
      outputPerMTokUsd: 2.5,
      cachedInputPerMTokUsd: 0.05,
      cacheWritePerMTokUsd: 0.625,
    });
  });

  it("fills a missing 1-hour cache-write rate, keeping a recorded one", async () => {
    const price = seedPrices.find((p) => p.model === "claude-haiku-5-5");
    if (!price) throw new Error("expected Claude Haiku 5.5 in the seed data");
    const match = and(
      eq(modelPricing.provider, price.provider),
      eq(modelPricing.model, price.model),
      eq(modelPricing.effectiveFrom, new Date(price.effectiveFrom)),
    );
    const row = async () =>
      (await db.select().from(modelPricing).where(match))[0];
    const before = await row();
    expect(before).toMatchObject({
      cacheWrite1hPerMTokUsd: "0.200000",
      longCacheWrite1hPerMTokUsd: "1.000000",
    });
    try {
      // A row seeded before the 1-hour columns existed has neither.
      await db
        .update(modelPricing)
        .set({ cacheWrite1hPerMTokUsd: null, longCacheWrite1hPerMTokUsd: null })
        .where(match);
      expect((await seed(db)).filled).toBe(1);
      expect(await row()).toMatchObject({
        cacheWrite1hPerMTokUsd: "0.200000",
        longCacheWrite1hPerMTokUsd: "1.000000",
        inputPerMTokUsd: before.inputPerMTokUsd,
      });

      // A rate someone recorded is kept.
      await db
        .update(modelPricing)
        .set({ cacheWrite1hPerMTokUsd: "0.25" })
        .where(match);
      expect((await seed(db)).filled).toBe(0);
      expect((await row()).cacheWrite1hPerMTokUsd).toBe("0.250000");
    } finally {
      await db
        .update(modelPricing)
        .set({
          cacheWrite1hPerMTokUsd: before.cacheWrite1hPerMTokUsd,
          longCacheWrite1hPerMTokUsd: before.longCacheWrite1hPerMTokUsd,
        })
        .where(match);
    }
  });
});
