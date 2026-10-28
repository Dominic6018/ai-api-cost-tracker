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

  it("has valid, non-overlapping date ranges per model", () => {
    const byModel = new Map<string, typeof seedPrices>();
    for (const price of seedPrices) {
      const key = `${price.provider}/${price.model}`;
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

describe("sample projects", () => {
  it("has at least one project with unique slugs", () => {
    expect(sampleProjects.length).toBeGreaterThan(0);
    const slugs = sampleProjects.map((p) => p.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });
});
