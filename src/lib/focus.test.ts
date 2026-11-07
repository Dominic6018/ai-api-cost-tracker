import { describe, expect, it } from "vitest";
import { calculateCostUsd } from "./cost";
import {
  FOCUS_COLUMNS,
  focusRows,
  formatDecimal,
  ratesFor,
  type FocusPricing,
  type FocusUsage,
} from "./focus";
import { toTokenPricing } from "./pricing";

// Claude Haiku 5.5-like rates, with a long-prompt tier above 100,000 tokens.
const pricing: FocusPricing = {
  id: "0c4f2d1e-0000-4000-8000-000000000001",
  effectiveFrom: new Date("2026-10-28T00:00:00Z"),
  effectiveTo: null,
  inputPerMTokUsd: "0.10",
  outputPerMTokUsd: "0.50",
  cachedInputPerMTokUsd: "0.01",
  cacheWritePerMTokUsd: "0.125",
  cacheWrite1hPerMTokUsd: null,
  longContextThresholdTokens: 100_000,
  longInputPerMTokUsd: "0.50",
  longOutputPerMTokUsd: "2.50",
  longCachedInputPerMTokUsd: null,
  longCacheWritePerMTokUsd: "0.625",
  longCacheWrite1hPerMTokUsd: null,
  batchMultiplier: null,
  webSearchPer1kUsd: null,
  audioInputPerMTokUsd: null,
  cachedAudioInputPerMTokUsd: null,
  audioOutputPerMTokUsd: null,
};

const usage: FocusUsage = {
  id: "5d0e8a2c-0000-4000-8000-000000000002",
  occurredAt: new Date("2026-11-04T13:45:12.345Z"),
  projectId: "7be6abbf-0000-4000-8000-000000000003",
  projectName: "Support Bot",
  provider: "anthropic",
  model: "claude-haiku-5-5",
  inputTokens: 12_000,
  cachedInputTokens: 8_000,
  cacheWriteInputTokens: 1_000,
  cacheWrite1hInputTokens: 0,
  serviceTier: "standard",
  outputTokens: 700,
  requestId: "msg_01abc",
  customerId: "cus_42",
  userId: null,
  feature: "support-chat",
  runId: null,
  tags: null,
  webSearchRequests: 0,
  audioInputTokens: 0,
  cachedAudioInputTokens: 0,
  audioOutputTokens: 0,
};

/** Sum of ListCost in micro-dollars, rounded half up like stored costs. */
const listCostMicros = (rows: ReturnType<typeof focusRows>) => {
  const total = rows.reduce((sum, r) => sum + Number(r.ListCost), 0);
  return Math.round(total * 1e6);
};

describe("focusRows", () => {
  const rows = focusRows(usage, pricing);

  it("has every column, in order, for each token type used", () => {
    expect(rows.map((r) => r.SkuMeter)).toEqual([
      "Input Tokens",
      "Cached Input Tokens",
      "Cache Write Input Tokens",
      "Output Tokens",
    ]);
    for (const row of rows) expect(Object.keys(row)).toEqual(FOCUS_COLUMNS);
  });

  it("is strictly compliant: nothing billed, the estimate as ListCost", () => {
    for (const row of rows) {
      expect([row.BilledCost, row.EffectiveCost, row.ContractedCost]).toEqual([
        "0",
        "0",
        "0",
      ]);
      // ListCost MUST equal ListUnitPrice × PricingQuantity.
      expect(Number(row.ListCost)).toBeCloseTo(
        Number(row.ListUnitPrice) * Number(row.PricingQuantity),
        12,
      );
    }
    // 3,000 uncached input at $0.10, 8,000 cached at $0.01,
    // 1,000 cache writes at $0.125 and 700 output at $0.50, per 1M.
    expect(
      rows.map((r) => [r.ListUnitPrice, r.PricingQuantity, r.ListCost]),
    ).toEqual([
      ["0.1", "0.003", "0.0003"],
      ["0.01", "0.008", "0.00008"],
      ["0.125", "0.001", "0.000125"],
      ["0.5", "0.0007", "0.00035"],
    ]);
  });

  it("adds up to the cost the tracker records for the request", () => {
    const recorded = calculateCostUsd(usage, toTokenPricing(pricing));
    expect(listCostMicros(rows)).toBe(Math.round(recorded * 1e6));
  });

  it("lists batch usage at the batch price, still adding up", () => {
    const withBatch = { ...pricing, batchMultiplier: "0.500" };
    const batchUsage = { ...usage, serviceTier: "batch" as const };
    const batchRows = focusRows(batchUsage, withBatch);
    const input = batchRows.find((row) => row.SkuId?.endsWith("/input"));
    // Haiku's $0.10 input at 0.500 is $0.05, written exactly.
    expect(input).toMatchObject({
      ListUnitPrice: "0.05",
      SkuPriceId: `${pricing.id}/input/batch`,
    });
    expect(input?.ChargeDescription).toMatch(/\(batch\)$/);
    const recorded = calculateCostUsd(batchUsage, toTokenPricing(withBatch));
    expect(listCostMicros(batchRows)).toBe(Math.round(recorded * 1e6));
  });

  it("lists web searches as their own row, per 1,000", () => {
    const withSearch = { ...pricing, webSearchPer1kUsd: "10.000000" };
    const searched = { ...usage, webSearchRequests: 3 };
    const searchRows = focusRows(searched, withSearch);
    expect(searchRows).toHaveLength(rows.length + 1);
    const search = searchRows.at(-1)!;
    expect(Object.keys(search)).toEqual(FOCUS_COLUMNS);
    expect(search).toMatchObject({
      ListUnitPrice: "10",
      PricingQuantity: "0.003",
      PricingUnit: "1000 Searches",
      ListCost: "0.03",
      ConsumedQuantity: "3",
      ConsumedUnit: "Requests",
      SkuId: "anthropic/claude-haiku-5-5/web-search",
      SkuPriceId: `${pricing.id}/web-search`,
      SkuMeter: "Web Searches",
      ChargeDescription: "claude-haiku-5-5 web searches",
      BilledCost: "0",
    });
    // Tokens plus $0.03 of searches, as recorded.
    const recorded = calculateCostUsd(usage, toTokenPricing(pricing));
    expect(listCostMicros(searchRows)).toBe(
      Math.round(recorded * 1e6) + 30_000,
    );
  });

  it("lists audio tokens at the audio rates, apart from text", () => {
    // gpt-realtime-2.1-like rates, at Haiku's text rates.
    const withAudio = {
      ...pricing,
      longContextThresholdTokens: null,
      longInputPerMTokUsd: null,
      longOutputPerMTokUsd: null,
      longCacheWritePerMTokUsd: null,
      audioInputPerMTokUsd: "32",
      cachedAudioInputPerMTokUsd: "0.40",
      audioOutputPerMTokUsd: "64",
    };
    // 12,000 input: 8,000 cached (2,000 of them audio), 1,000 cache writes,
    // 1,500 uncached audio; 700 output, 300 of it audio.
    const spoken = {
      ...usage,
      audioInputTokens: 3_500,
      cachedAudioInputTokens: 2_000,
      audioOutputTokens: 300,
    };
    const audioRows = focusRows(spoken, withAudio);
    const byKey: Record<string, (typeof audioRows)[number]> =
      Object.fromEntries(audioRows.map((r) => [r.SkuId!.split("/").at(-1), r]));
    expect(
      Object.fromEntries(
        Object.entries(byKey).map(
          ([k, r]: [string, (typeof audioRows)[number]]) => [
            k,
            [r.ConsumedQuantity, r.ListUnitPrice],
          ],
        ),
      ),
    ).toEqual({
      input: ["1500", "0.1"],
      "cached-input": ["6000", "0.01"],
      "cache-write": ["1000", "0.125"],
      output: ["400", "0.5"],
      "audio-input": ["1500", "32"],
      "cached-audio-input": ["2000", "0.4"],
      "audio-output": ["300", "64"],
    });
    expect(byKey["audio-output"].SkuMeter).toBe("Audio Output Tokens");
    const recorded = calculateCostUsd(spoken, toTokenPricing(withAudio));
    expect(listCostMicros(audioRows)).toBe(Math.round(recorded * 1e6));
  });

  it("refuses audio tokens without audio rates", () => {
    expect(() =>
      focusRows({ ...usage, audioOutputTokens: 1 }, pricing),
    ).toThrow(TypeError);
  });

  it("refuses web searches without a web search price", () => {
    expect(() =>
      focusRows({ ...usage, webSearchRequests: 1 }, pricing),
    ).toThrow(TypeError);
  });

  it("refuses batch usage without a batch price", () => {
    expect(() =>
      focusRows({ ...usage, serviceTier: "batch" }, pricing),
    ).toThrow(TypeError);
  });

  it("splits 1-hour cache writes into their own row, still adding up", () => {
    // Claude Haiku 5.5: 1-hour writes at $0.20, against $0.125 for 5 minutes.
    const withHour = { ...pricing, cacheWrite1hPerMTokUsd: "0.20" };
    const split = { ...usage, cacheWrite1hInputTokens: 400 };
    const splitRows = focusRows(split, withHour);
    const byType = Object.fromEntries(
      splitRows.map((row) => [row.SkuId?.split("/").pop(), row]),
    );
    expect(byType["cache-write"]).toMatchObject({
      PricingQuantity: "0.0006",
      ListUnitPrice: "0.125",
    });
    expect(byType["cache-write-1h"]).toMatchObject({
      PricingQuantity: "0.0004",
      ListUnitPrice: "0.2",
      ConsumedQuantity: "400",
    });
    const recorded = calculateCostUsd(split, toTokenPricing(withHour));
    expect(listCostMicros(splitRows)).toBe(Math.round(recorded * 1e6));
  });

  it("prices every token at the long rates above the threshold", () => {
    const long = { ...usage, inputTokens: 150_000 };
    const longRows = focusRows(long, pricing);
    const recorded = calculateCostUsd(long, toTokenPricing(pricing));
    expect(listCostMicros(longRows)).toBe(Math.round(recorded * 1e6));
    // The long tier has no cached rate, so cached input uses long input.
    expect(longRows.map((r) => r.ListUnitPrice)).toEqual([
      "0.5",
      "0.5",
      "0.625",
      "2.5",
    ]);
    expect(longRows[0].SkuPriceId).toBe(`${pricing.id}/input/long-prompt`);
    // The SKU stays the same; only its price differs.
    expect(longRows[0].SkuId).toBe(rows[0].SkuId);
  });

  it("uses FOCUS's allowed values and units", () => {
    expect(rows[0]).toMatchObject({
      ChargeCategory: "Usage",
      ChargeClass: null,
      ChargeFrequency: "Usage-Based",
      PricingCategory: "Standard",
      PricingUnit: "1000000 Tokens",
      ConsumedQuantity: "3000",
      ConsumedUnit: "Tokens",
      BillingCurrency: "USD",
      ServiceCategory: "AI and Machine Learning",
      ServiceSubcategory: "Generative AI",
      ServiceName: "Claude API",
      InvoiceIssuerName: "Anthropic",
      ServiceProviderName: "Anthropic",
      HostProviderName: "Anthropic",
      SkuId: "anthropic/claude-haiku-5-5/input",
      ChargeDescription: "claude-haiku-5-5 input tokens",
    });
  });

  it("uses UTC ISO 8601 hour and month periods, end exclusive", () => {
    expect(rows[0]).toMatchObject({
      ChargePeriodStart: "2026-11-04T13:00:00Z",
      ChargePeriodEnd: "2026-11-04T14:00:00Z",
      BillingPeriodStart: "2026-11-01T00:00:00Z",
      BillingPeriodEnd: "2026-12-01T00:00:00Z",
    });
    const december = focusRows(
      { ...usage, occurredAt: new Date("2026-12-31T23:59:59Z") },
      pricing,
    )[0];
    expect([december.ChargePeriodEnd, december.BillingPeriodEnd]).toEqual([
      "2027-01-01T00:00:00Z",
      "2027-01-01T00:00:00Z",
    ]);
  });

  it("puts the project in the sub account and attribution in Tags", () => {
    expect(rows[0]).toMatchObject({
      SubAccountId: usage.projectId,
      SubAccountName: "Support Bot",
      SubAccountType: "Project",
      x_UsageEventId: usage.id,
      x_RequestId: "msg_01abc",
    });
    expect(JSON.parse(rows[0].Tags!)).toEqual({
      customerId: "cus_42",
      feature: "support-chat",
    });
    const bare = focusRows(
      { ...usage, customerId: null, feature: null },
      pricing,
    )[0];
    expect(bare.Tags).toBeNull();
    // Free-form tags join attribution in the one object.
    const tagged = focusRows(
      { ...usage, tags: { env: "prod", team: "search" } },
      pricing,
    )[0];
    expect(JSON.parse(tagged.Tags!)).toEqual({
      env: "prod",
      team: "search",
      customerId: "cus_42",
      feature: "support-chat",
    });
  });

  it("leaves out token types with no tokens", () => {
    const plain = focusRows(
      { ...usage, cachedInputTokens: 0, cacheWriteInputTokens: 0 },
      pricing,
    );
    expect(plain.map((r) => r.SkuMeter)).toEqual([
      "Input Tokens",
      "Output Tokens",
    ]);
  });

  it("only leaves nullable FOCUS columns empty", () => {
    const nullable = new Set(["ChargeClass", "Tags", "x_RequestId"]);
    const withNulls = focusRows(
      { ...usage, requestId: null, customerId: null, feature: null },
      pricing,
    );
    for (const row of withNulls) {
      for (const [column, value] of Object.entries(row)) {
        if (value === null) expect(nullable.has(column)).toBe(true);
      }
    }
  });
});

describe("ratesFor", () => {
  it("falls back to the input rate for missing cached and cache-write rates", () => {
    const bare = {
      ...pricing,
      cachedInputPerMTokUsd: null,
      cacheWritePerMTokUsd: null,
    };
    expect(ratesFor(bare, 1000).rates).toEqual({
      input: "0.10",
      "cached-input": "0.10",
      "cache-write": "0.10",
      "cache-write-1h": "0.10",
      output: "0.50",
      // Not priced: never listed (audio usage without them throws).
      "audio-input": "0",
      "cached-audio-input": "0",
      "audio-output": "0",
    });
  });

  it("switches tiers only strictly above the threshold", () => {
    expect(ratesFor(pricing, 100_000).long).toBe(false);
    expect(ratesFor(pricing, 100_001).long).toBe(true);
  });
});

describe("formatDecimal", () => {
  it("writes plain decimals without trailing zeros", () => {
    expect(formatDecimal({ units: 3_000n, scale: 6 })).toBe("0.003");
    expect(formatDecimal({ units: 250n, scale: 2 })).toBe("2.5");
    expect(formatDecimal({ units: 7n, scale: 0 })).toBe("7");
    expect(formatDecimal({ units: 0n, scale: 4 })).toBe("0");
    expect(formatDecimal({ units: 12_345_678n, scale: 6 })).toBe("12.345678");
  });
});
