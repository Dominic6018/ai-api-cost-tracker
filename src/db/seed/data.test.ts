import { describe, expect, it } from "vitest";
import { calculateCostUsd, type TokenPricing } from "@/lib/cost";
import { providerEnum } from "../schema";
import { sampleProjects, seedPrices } from "./data";

const OFFICIAL_SOURCES: Record<string, string> = {
  anthropic: "https://platform.claude.com/",
  openai: "https://developers.openai.com/",
  google: "https://ai.google.dev/",
};

const isDecimal = (value: string) => /^\d+(\.\d{1,6})?$/.test(value);

describe("seed prices", () => {
  it("uses known providers and an official source for each price", () => {
    for (const price of seedPrices) {
      expect(providerEnum.enumValues).toContain(price.provider);
      expect(price.source.startsWith(OFFICIAL_SOURCES[price.provider])).toBe(
        true,
      );
    }
  });

  it("records a valid check date for each price", () => {
    for (const price of seedPrices) {
      expect(price.checkedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(Date.parse(price.checkedOn))).toBe(false);
    }
  });

  it("stores amounts as non-negative decimals within numeric(12, 6)", () => {
    for (const price of seedPrices) {
      const amounts = [
        price.inputPerMTokUsd,
        price.outputPerMTokUsd,
        price.cachedInputPerMTokUsd,
      ].filter((v): v is string => v !== null);
      for (const amount of amounts) expect(isDecimal(amount)).toBe(true);
    }
  });

  it("prices cached input no higher than regular input", () => {
    for (const price of seedPrices) {
      if (price.cachedInputPerMTokUsd === null) continue;
      expect(Number(price.cachedInputPerMTokUsd)).toBeLessThanOrEqual(
        Number(price.inputPerMTokUsd),
      );
    }
  });

  it("has valid, non-overlapping date ranges per model and tier", () => {
    const byModel = new Map<string, typeof seedPrices>();
    for (const price of seedPrices) {
      const key = `${price.provider}/${price.model}/${price.serviceTier ?? "standard"}`;
      byModel.set(key, [...(byModel.get(key) ?? []), price]);
    }

    for (const prices of byModel.values()) {
      const ranges = prices
        .map((p) => ({
          from: Date.parse(p.effectiveFrom),
          to: p.effectiveTo ? Date.parse(p.effectiveTo) : Infinity,
        }))
        .sort((a, b) => a.from - b.from);

      for (const [i, range] of ranges.entries()) {
        expect(Number.isNaN(range.from)).toBe(false);
        expect(range.to).toBeGreaterThan(range.from);
        const next = ranges[i + 1];
        if (next) expect(next.from).toBeGreaterThanOrEqual(range.to);
      }
    }
  });
});

describe("seed price tiers and cache writes", () => {
  const tiered = seedPrices.filter((p) => p.longContext);

  it("includes tiered models", () => {
    expect(tiered.map((p) => p.model)).toEqual(
      expect.arrayContaining(["claude-haiku-5-5", "gemini-2.5-pro"]),
    );
  });

  it("uses whole, positive token thresholds", () => {
    for (const price of tiered) {
      expect(Number.isInteger(price.longContext!.thresholdTokens)).toBe(true);
      expect(price.longContext!.thresholdTokens).toBeGreaterThan(0);
    }
  });

  it("stores long-tier and cache-write amounts as decimals", () => {
    for (const price of seedPrices) {
      const long = price.longContext;
      const amounts = [
        price.cacheWritePerMTokUsd,
        long?.inputPerMTokUsd,
        long?.outputPerMTokUsd,
        long?.cachedInputPerMTokUsd,
        long?.cacheWritePerMTokUsd,
      ].filter((v): v is string => v !== undefined);
      for (const amount of amounts) expect(isDecimal(amount)).toBe(true);
    }
  });

  it("charges more for long prompts, never less", () => {
    for (const { inputPerMTokUsd, outputPerMTokUsd, longContext } of tiered) {
      expect(Number(longContext!.inputPerMTokUsd)).toBeGreaterThan(
        Number(inputPerMTokUsd),
      );
      expect(Number(longContext!.outputPerMTokUsd)).toBeGreaterThanOrEqual(
        Number(outputPerMTokUsd),
      );
    }
  });

  it("prices cache reads at or below input and writes at or above it", () => {
    for (const price of seedPrices) {
      const tiers = [price, price.longContext].filter(
        (t): t is NonNullable<typeof t> => Boolean(t),
      );
      for (const tier of tiers) {
        const input = Number(tier.inputPerMTokUsd);
        if (tier.cachedInputPerMTokUsd) {
          expect(Number(tier.cachedInputPerMTokUsd)).toBeLessThanOrEqual(input);
        }
        if (tier.cacheWritePerMTokUsd) {
          expect(Number(tier.cacheWritePerMTokUsd)).toBeGreaterThanOrEqual(
            input,
          );
        }
      }
    }
  });
});

describe("seed web search prices", () => {
  it("prices Anthropic searches at $10 per 1,000 on every Claude row", () => {
    for (const price of seedPrices.filter((p) => p.provider === "anthropic")) {
      expect(price.webSearchPer1kUsd).toBe("10");
    }
  });

  it("leaves unverified providers' searches unpriced", () => {
    for (const price of seedPrices.filter((p) => p.provider !== "anthropic")) {
      expect(price.webSearchPer1kUsd).toBeUndefined();
    }
  });
});

describe("gemini-2.5-pro routing to Gemini 3.8 Flash", () => {
  const rows = (model: string) =>
    seedPrices.filter((p) => p.provider === "google" && p.model === model);
  const at = (model: string, iso: string) =>
    rows(model).find(
      (p) =>
        Date.parse(p.effectiveFrom) <= Date.parse(iso) &&
        (!p.effectiveTo || Date.parse(p.effectiveTo) > Date.parse(iso)),
    );

  it("keeps its own rates, long tier included, until 2026-12-01", () => {
    const before = at("gemini-2.5-pro", "2026-11-30T23:59:59Z");
    expect(before).toMatchObject({ inputPerMTokUsd: "1.25" });
    expect(before?.effectiveTo).toBe("2026-12-01T00:00:00Z");
    expect(before?.longContext?.thresholdTokens).toBe(200_000);
  });

  it.each([
    "2026-12-01T00:00:00Z",
    "2026-12-31T23:59:59Z",
    "2027-01-01T00:00:00Z",
    "2030-01-01T00:00:00Z",
  ])("is billed at Gemini 3.8 Flash's rates at %s", (iso) => {
    const routed = at("gemini-2.5-pro", iso);
    const flash = at("gemini-3.8-flash", iso);
    expect(routed).toBeDefined();
    expect(flash).toBeDefined();
    for (const key of [
      "inputPerMTokUsd",
      "outputPerMTokUsd",
      "cachedInputPerMTokUsd",
    ] as const) {
      expect(Number(routed![key])).toBe(Number(flash![key]));
    }
    expect(routed!.longContext).toBeUndefined();
  });
});

describe("seed audio prices", () => {
  const audio = seedPrices.filter((p) => p.audio);

  it("seeds OpenAI's audio and realtime models", () => {
    expect(audio.map((p) => p.model)).toEqual([
      "gpt-audio",
      "gpt-audio-mini",
      "gpt-realtime-2.1",
      "gpt-realtime-2.1-mini",
    ]);
  });

  it("charges more for audio than text, and caches it no higher", () => {
    for (const p of audio) {
      expect(Number(p.audio!.inputPerMTokUsd)).toBeGreaterThan(
        Number(p.inputPerMTokUsd),
      );
      expect(Number(p.audio!.outputPerMTokUsd)).toBeGreaterThan(
        Number(p.outputPerMTokUsd),
      );
      if (p.audio!.cachedInputPerMTokUsd) {
        expect(Number(p.audio!.cachedInputPerMTokUsd)).toBeLessThanOrEqual(
          Number(p.audio!.inputPerMTokUsd),
        );
      }
    }
  });
});

describe("seed image prices", () => {
  it("seeds OpenAI's image models, image output above text input", () => {
    const image = seedPrices.filter((p) => p.image);
    expect(image.map((p) => p.model)).toEqual([
      "gpt-image-2",
      "gpt-image-1.5",
      "gpt-image-1-mini",
    ]);
    for (const p of image) {
      expect(Number(p.image!.outputPerMTokUsd)).toBeGreaterThan(
        Number(p.inputPerMTokUsd),
      );
      expect(Number(p.image!.cachedInputPerMTokUsd)).toBeLessThanOrEqual(
        Number(p.image!.inputPerMTokUsd),
      );
    }
  });
});

describe("sample projects", () => {
  it("has at least one project with unique slugs", () => {
    expect(sampleProjects.length).toBeGreaterThan(0);
    const slugs = sampleProjects.map((p) => p.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });
});

describe("OpenAI long-context prices", () => {
  const price = (model: string, tier?: "flex" | "fast") =>
    seedPrices.find(
      (p) =>
        p.provider === "openai" && p.model === model && p.serviceTier === tier,
    );

  const pricing = (model: string, tier?: "flex"): TokenPricing => {
    const row = price(model, tier);
    if (!row?.longContext) throw new Error(`expected a tier for ${model}`);
    return {
      inputPerMTokUsd: Number(row.inputPerMTokUsd),
      outputPerMTokUsd: Number(row.outputPerMTokUsd),
      cachedInputPerMTokUsd:
        row.cachedInputPerMTokUsd === null
          ? null
          : Number(row.cachedInputPerMTokUsd),
      longContext: {
        thresholdTokens: row.longContext.thresholdTokens,
        inputPerMTokUsd: Number(row.longContext.inputPerMTokUsd),
        outputPerMTokUsd: Number(row.longContext.outputPerMTokUsd),
        cachedInputPerMTokUsd: row.longContext.cachedInputPerMTokUsd
          ? Number(row.longContext.cachedInputPerMTokUsd)
          : null,
      },
    };
  };

  // [model, tier, short rates, long rates], from the pricing page.
  it.each([
    ["gpt-5.5", undefined, ["5", "30", "0.50"], ["10", "45", "1"]],
    ["gpt-5.5-pro", undefined, ["30", "180", null], ["60", "270", undefined]],
    ["gpt-5.4", undefined, ["2.50", "15", "0.25"], ["5", "22.50", "0.50"]],
    ["gpt-5.4-pro", undefined, ["30", "180", null], ["60", "270", undefined]],
    ["gpt-5.5", "flex", ["2.50", "15", "0.25"], ["5", "22.50", "0.50"]],
    ["gpt-5.4", "flex", ["1.25", "7.50", "0.13"], ["2.50", "11.25", "0.25"]],
    ["gpt-5.4-pro", "flex", ["15", "90", null], ["30", "135", undefined]],
  ] as const)("seeds %s (%s) as published", (model, tier, short, long) => {
    expect(price(model, tier)).toMatchObject({
      inputPerMTokUsd: short[0],
      outputPerMTokUsd: short[1],
      cachedInputPerMTokUsd: short[2],
      source: "https://developers.openai.com/api/docs/pricing",
      checkedOn: "2026-11-08",
    });
    expect(price(model, tier)?.longContext).toEqual({
      thresholdTokens: 272_000,
      inputPerMTokUsd: long[0],
      outputPerMTokUsd: long[1],
      cachedInputPerMTokUsd: long[2],
    });
  });

  it("leaves out tiers without published long rates", () => {
    expect(price("gpt-5.5-pro", "flex")).toBeUndefined();
    expect(price("gpt-5.5", "fast")).toBeUndefined();
    expect(price("gpt-5.4", "fast")).toBeUndefined();
  });

  it("switches the whole request to long rates above 272,000 tokens", () => {
    const usage = { outputTokens: 1_000 };
    expect(
      calculateCostUsd({ ...usage, inputTokens: 272_000 }, pricing("gpt-5.5")),
    ).toBe(1.39);
    expect(
      calculateCostUsd({ ...usage, inputTokens: 272_001 }, pricing("gpt-5.5")),
    ).toBe(2.76501);
  });

  it("counts cached tokens towards the threshold", () => {
    // 72,001 uncached at $10 and 200,000 cached at $1, plus no output.
    expect(
      calculateCostUsd(
        { inputTokens: 272_001, cachedInputTokens: 200_000, outputTokens: 0 },
        pricing("gpt-5.5"),
      ),
    ).toBe(0.92001);
  });
});
