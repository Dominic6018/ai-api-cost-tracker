import "dotenv/config";
import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { calculateCostUsd } from "@/lib/cost";
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
    expect(result.pricing.cacheWrite1hPerMTokUsd).toBe(0.2);
    expect(result.pricing.batchMultiplier).toBe(0.5);
    expect(result.pricing.longContext).toEqual({
      thresholdTokens: 100_000,
      inputPerMTokUsd: 0.5,
      outputPerMTokUsd: 2.5,
      cachedInputPerMTokUsd: 0.05,
      cacheWritePerMTokUsd: 0.625,
      cacheWrite1hPerMTokUsd: 1,
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

  it("fills a missing batch multiplier, keeping a recorded one", async () => {
    const price = seedPrices.find((p) => p.model === "claude-sonnet-5-5");
    if (!price) throw new Error("expected Claude Sonnet 5.5 in the seed data");
    const match = and(
      eq(modelPricing.provider, price.provider),
      eq(modelPricing.model, price.model),
      eq(modelPricing.effectiveFrom, new Date(price.effectiveFrom)),
    );
    const multiplier = async () =>
      (await db.select().from(modelPricing).where(match))[0].batchMultiplier;
    expect(await multiplier()).toBe("0.500");
    try {
      await db.update(modelPricing).set({ batchMultiplier: null }).where(match);
      expect((await seed(db)).filled).toBe(1);
      expect(await multiplier()).toBe("0.500");

      await db
        .update(modelPricing)
        .set({ batchMultiplier: "0.4" })
        .where(match);
      expect((await seed(db)).filled).toBe(0);
      expect(await multiplier()).toBe("0.400");
    } finally {
      await db
        .update(modelPricing)
        .set({ batchMultiplier: "0.5" })
        .where(match);
    }
  });

  it("fills a missing web search price, keeping a recorded one", async () => {
    const price = seedPrices.find((p) => p.model === "claude-fable-5-1");
    if (!price) throw new Error("expected Claude Fable 5.1 in the seed data");
    const match = and(
      eq(modelPricing.provider, price.provider),
      eq(modelPricing.model, price.model),
      eq(modelPricing.effectiveFrom, new Date(price.effectiveFrom)),
    );
    const searchPrice = async () =>
      (await db.select().from(modelPricing).where(match))[0].webSearchPer1kUsd;
    expect(await searchPrice()).toBe("10.000000");
    try {
      // A row seeded before web search prices existed has none.
      await db
        .update(modelPricing)
        .set({ webSearchPer1kUsd: null })
        .where(match);
      expect((await seed(db)).filled).toBe(1);
      expect(await searchPrice()).toBe("10.000000");

      await db
        .update(modelPricing)
        .set({ webSearchPer1kUsd: "12" })
        .where(match);
      expect((await seed(db)).filled).toBe(0);
      expect(await searchPrice()).toBe("12.000000");
    } finally {
      await db
        .update(modelPricing)
        .set({ webSearchPer1kUsd: "10" })
        .where(match);
    }
  });

  it("prices gemini-2.5-pro at Gemini 3.8 Flash's rates once it's routed there", async () => {
    const input = async (at: string, inputTokens = 1_000) => {
      const result = await findEffectivePricing(db, {
        provider: "google",
        model: "gemini-2.5-pro",
        at: new Date(at),
        serviceTier: "standard",
      });
      if (!result.found) throw new Error(`no gemini-2.5-pro price at ${at}`);
      return calculateCostUsd(
        {
          inputTokens,
          outputTokens: 0,
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          cacheWrite1hInputTokens: 0,
        },
        result.pricing,
      );
    };
    // 100K input tokens at $1.25 per 1M; 300K is over 2.5 Pro's 200K
    // threshold, so all of it pays the long $2.50.
    expect(await input("2026-11-30T23:59:59Z", 100_000)).toBe(0.125);
    expect(await input("2026-11-30T23:59:59Z", 300_000)).toBe(0.75);
    // Routed: $0.75 per 1M, with no long tier, so 300K costs $0.225.
    expect(await input("2026-12-01T00:00:00Z", 100_000)).toBe(0.075);
    expect(await input("2026-12-01T00:00:00Z", 300_000)).toBe(0.225);
    // Gemini 3.8 Flash's 2027 rate: $1.50 per 1M.
    expect(await input("2027-01-01T00:00:00Z", 100_000)).toBe(0.15);
  });

  it("fills a missing end date, keeping a recorded one", async () => {
    // A database seeded before the routing was announced has the old
    // gemini-2.5-pro price open-ended.
    const match = and(
      eq(modelPricing.provider, "google"),
      eq(modelPricing.model, "gemini-2.5-pro"),
      eq(modelPricing.effectiveFrom, new Date("2026-10-28T00:00:00Z")),
    );
    const end = async () =>
      (await db.select().from(modelPricing).where(match))[0].effectiveTo;
    expect(await end()).toEqual(new Date("2026-12-01T00:00:00Z"));
    try {
      await db.update(modelPricing).set({ effectiveTo: null }).where(match);
      expect((await seed(db)).filled).toBe(1);
      expect(await end()).toEqual(new Date("2026-12-01T00:00:00Z"));

      // An end someone recorded is kept.
      await db
        .update(modelPricing)
        .set({ effectiveTo: new Date("2026-11-15T00:00:00Z") })
        .where(match);
      expect((await seed(db)).filled).toBe(0);
      expect(await end()).toEqual(new Date("2026-11-15T00:00:00Z"));
    } finally {
      await db
        .update(modelPricing)
        .set({ effectiveTo: new Date("2026-12-01T00:00:00Z") })
        .where(match);
    }
  });

  it("seeds image rates that the lookup returns", async () => {
    const result = await findEffectivePricing(db, {
      provider: "openai",
      model: "gpt-image-2",
      at: new Date("2026-11-08T00:00:00Z"),
      serviceTier: "standard",
    });
    expect(result.found && result.pricing.image).toEqual({
      inputPerMTokUsd: 8,
      cachedInputPerMTokUsd: 2,
      outputPerMTokUsd: 30,
    });
  });

  it("seeds audio rates that the lookup returns", async () => {
    const result = await findEffectivePricing(db, {
      provider: "openai",
      model: "gpt-realtime-2.1",
      at: new Date("2026-11-08T00:00:00Z"),
      serviceTier: "standard",
    });
    expect(result.found && result.pricing.audio).toEqual({
      inputPerMTokUsd: 32,
      cachedInputPerMTokUsd: 0.4,
      outputPerMTokUsd: 64,
    });
  });

  it("seeds flex and fast prices that the lookup finds per tier", async () => {
    const at = new Date("2026-11-08T00:00:00Z");
    const input = async (
      provider: "anthropic" | "openai",
      model: string,
      serviceTier: "standard" | "flex" | "fast",
    ) => {
      const result = await findEffectivePricing(db, {
        provider,
        model,
        at,
        serviceTier,
      });
      return result.found ? result.pricing.inputPerMTokUsd : null;
    };
    expect(await input("anthropic", "claude-opus-5-5", "standard")).toBe(4);
    expect(await input("anthropic", "claude-opus-5-5", "fast")).toBe(8);
    expect(await input("openai", "gpt-4.1", "fast")).toBe(3.5);
    expect(await input("openai", "gpt-5.4-mini", "flex")).toBe(0.375);
    // Not in OpenAI's Flex table, so not seeded.
    expect(await input("openai", "gpt-4.1", "flex")).toBeNull();
    // Tier prices apply from the day they were checked.
    const before = await findEffectivePricing(db, {
      provider: "openai",
      model: "gpt-4.1",
      at: new Date("2026-11-06T23:59:59Z"),
      serviceTier: "fast",
    });
    expect(before.found).toBe(false);
  });
});
