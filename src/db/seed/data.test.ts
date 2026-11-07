import { describe, expect, it } from "vitest";
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
