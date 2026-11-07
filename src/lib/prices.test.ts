import { describe, expect, it } from "vitest";
import {
  formatBatchMultiplier,
  formatRate,
  needsRecheck,
  priceHistories,
  type PriceListRow,
} from "./prices";

const NOW = new Date("2026-11-06T12:00:00Z");

let next = 0;
const price = (
  provider: string,
  model: string,
  effectiveFrom: string,
  effectiveTo: string | null = null,
): PriceListRow => ({
  id: `p${next++}`,
  provider,
  model,
  serviceTier: "standard",
  effectiveFrom: new Date(effectiveFrom),
  effectiveTo: effectiveTo ? new Date(effectiveTo) : null,
  inputPerMTokUsd: "1.000000",
  outputPerMTokUsd: "2.000000",
  cachedInputPerMTokUsd: null,
  cacheWritePerMTokUsd: null,
  cacheWrite1hPerMTokUsd: null,
  longContextThresholdTokens: null,
  longInputPerMTokUsd: null,
  longOutputPerMTokUsd: null,
  longCachedInputPerMTokUsd: null,
  longCacheWritePerMTokUsd: null,
  longCacheWrite1hPerMTokUsd: null,
  batchMultiplier: null,
  webSearchPer1kUsd: null,
  audioInputPerMTokUsd: null,
  cachedAudioInputPerMTokUsd: null,
  audioOutputPerMTokUsd: null,
  sourceUrl: "https://example.com/pricing",
  checkedOn: "2026-11-01",
});

describe("priceHistories", () => {
  it("groups by provider and model, newest first, with each status", () => {
    const old = price(
      "google",
      "flash",
      "2026-01-01T00:00:00Z",
      "2027-01-01T00:00:00Z",
    );
    const later = price("google", "flash", "2027-01-01T00:00:00Z");
    const claude = price("anthropic", "sonnet", "2026-10-01T00:00:00Z");
    const histories = priceHistories([old, later, claude], NOW);
    expect(
      histories.map((h) => [
        h.provider,
        h.model,
        h.prices.map((p) => [p.row.id, p.status]),
      ]),
    ).toEqual([
      ["anthropic", "sonnet", [[claude.id, "current"]]],
      [
        "google",
        "flash",
        [
          [later.id, "scheduled"],
          [old.id, "current"],
        ],
      ],
    ]);
  });

  it("treats the end of a range as exclusive and its start as inclusive", () => {
    const ended = price(
      "openai",
      "m",
      "2026-01-01T00:00:00Z",
      "2026-11-06T12:00:00Z",
    );
    const starts = price("openai", "m", "2026-11-06T12:00:00Z");
    expect(
      priceHistories([ended, starts], NOW)[0].prices.map((p) => p.status),
    ).toEqual(["current", "ended"]);
  });

  it("marks an open-ended price superseded by a newer one as ended", () => {
    const first = price("openai", "m", "2026-01-01T00:00:00Z");
    const second = price("openai", "m", "2026-06-01T00:00:00Z");
    expect(
      priceHistories([first, second], NOW)[0].prices.map((p) => [
        p.row.id,
        p.status,
      ]),
    ).toEqual([
      [second.id, "current"],
      [first.id, "ended"],
    ]);
  });

  it("has no current price for a model whose prices have all ended", () => {
    const ended = price(
      "openai",
      "old",
      "2025-01-01T00:00:00Z",
      "2026-01-01T00:00:00Z",
    );
    expect(priceHistories([ended], NOW)[0].prices[0].status).toBe("ended");
  });
});

describe("needsRecheck", () => {
  it("flags a missing check date, or one more than 90 days old", () => {
    expect(needsRecheck(null, NOW)).toBe(true);
    // Nov 6 is exactly 90 days after Aug 8.
    expect(needsRecheck("2026-08-08", NOW)).toBe(false);
    expect(needsRecheck("2026-08-07", NOW)).toBe(true);
    expect(needsRecheck("2026-11-06", NOW)).toBe(false);
  });
});

describe("formatRate", () => {
  it.each([
    ["3.000000", "$3.00"],
    ["0.037500", "$0.0375"],
    ["0.075000", "$0.075"],
    ["12.500000", "$12.50"],
    ["0.000001", "$0.000001"],
    ["5", "$5.00"],
  ])("shows %s as %s", (value, text) => {
    expect(formatRate(value)).toBe(text);
  });
});

describe("formatBatchMultiplier", () => {
  it.each([
    ["0.500", "50%"],
    ["0.5", "50%"],
    ["1.000", "100%"],
    ["0.125", "12.5%"],
    ["0.001", "0.1%"],
  ])("shows %s as %s", (value, text) => {
    expect(formatBatchMultiplier(value)).toBe(text);
  });

  it("shows a dash without a batch price", () => {
    expect(formatBatchMultiplier(null)).toBe("—");
  });
});

describe("priceHistories with tiers", () => {
  it("keeps each tier's history apart, standard first", () => {
    const standard = price("openai", "gpt-4.1", "2026-01-01T00:00:00Z");
    const fast = {
      ...price("openai", "gpt-4.1", "2026-11-07T00:00:00Z"),
      serviceTier: "fast",
    };
    const flex = {
      ...price("openai", "gpt-4.1", "2026-11-07T00:00:00Z"),
      serviceTier: "flex",
    };
    const histories = priceHistories([fast, flex, standard], NOW);
    expect(
      histories.map((h) => [h.serviceTier, h.prices.map((p) => p.status)]),
    ).toEqual([
      // A newer fast price doesn't supersede the standard one.
      ["standard", ["current"]],
      ["flex", ["scheduled"]],
      ["fast", ["scheduled"]],
    ]);
  });
});
