import { describe, expect, it } from "vitest";
import { estimateSavings, type PriceOption, type Workload } from "./savings";

const parts = (input: number, cached: number, output: number) => ({
  input: BigInt(input),
  cached: BigInt(cached),
  writes: 0n,
  writes1h: 0n,
  output: BigInt(output),
});

// 1M input, none cached, 100k output at $2 / $8 per 1M: $2.80.
const workload: Workload = {
  provider: "openai",
  model: "big",
  requests: 100n,
  costMicros: 2_800_000n,
  parts: parts(1_000_000, 0, 100_000),
};

const prices: PriceOption[] = [
  {
    provider: "openai",
    model: "big",
    pricing: {
      inputPerMTokUsd: 2,
      cachedInputPerMTokUsd: 0.5,
      outputPerMTokUsd: 8,
      batchMultiplier: 0.5,
    },
  },
  {
    provider: "openai",
    model: "mini",
    pricing: {
      inputPerMTokUsd: 0.4,
      cachedInputPerMTokUsd: 0.1,
      outputPerMTokUsd: 1.6,
    },
  },
  {
    provider: "openai",
    model: "huge",
    pricing: { inputPerMTokUsd: 10, outputPerMTokUsd: 40 },
  },
  // Cheaper, but another provider's model isn't offered.
  {
    provider: "google",
    model: "tiny",
    pricing: { inputPerMTokUsd: 0.01, outputPerMTokUsd: 0.01 },
  },
];

describe("estimateSavings", () => {
  it("estimates batching, caching and a cheaper model from the workload", () => {
    const report = estimateSavings([workload], prices);
    expect(report.rows).toEqual([
      {
        provider: "openai",
        model: "big",
        requests: 100n,
        costMicros: 2_800_000n,
        priced: true,
        // Half price in a batch.
        batch: { multiplier: 0.5, savingMicros: 1_400_000n },
        // 100k of the 1M uncached input at $0.50 instead of $2.
        cachingPer10Percent: 150_000n,
        // The same tokens on mini: $0.40 + $0.16.
        alternative: {
          model: "mini",
          costMicros: 560_000n,
          savingMicros: 2_240_000n,
        },
      },
    ]);
    expect(report).toMatchObject({
      costMicros: 2_800_000n,
      batchMicros: 1_400_000n,
      cachingPer10PercentMicros: 150_000n,
      alternativeMicros: 2_240_000n,
    });
  });

  it("offers nothing it can't price", () => {
    const report = estimateSavings(
      [
        { ...workload, model: "retired" },
        // No batch price, no cache discount, already the cheapest.
        { ...workload, model: "mini", costMicros: 560_000n },
      ],
      prices,
    );
    const [retired, mini] = report.rows;
    expect(retired).toMatchObject({
      model: "retired",
      priced: false,
      batch: null,
      cachingPer10Percent: null,
      alternative: null,
    });
    expect(mini).toMatchObject({
      model: "mini",
      priced: true,
      batch: null,
      alternative: null,
    });
  });

  it("has no caching estimate when all input is already cached", () => {
    const [row] = estimateSavings(
      [{ ...workload, parts: parts(1_000_000, 1_000_000, 100_000) }],
      prices,
    ).rows;
    expect(row.cachingPer10Percent).toBeNull();
  });

  it("lists the costliest models first", () => {
    const report = estimateSavings(
      [
        { ...workload, model: "mini", costMicros: 1n },
        { ...workload, costMicros: 5n },
      ],
      prices,
    );
    expect(report.rows.map((r) => r.model)).toEqual(["big", "mini"]);
  });
});
