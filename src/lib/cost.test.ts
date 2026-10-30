import { describe, expect, it } from "vitest";
import { calculateCostUsd, formatUsd, ratesForUsage } from "./cost";

const pricing = {
  inputPerMTokUsd: 3,
  outputPerMTokUsd: 15,
  cachedInputPerMTokUsd: 0.3,
};

describe("calculateCostUsd", () => {
  it("prices input and output tokens per million", () => {
    expect(
      calculateCostUsd(
        { inputTokens: 1_000_000, outputTokens: 1_000_000 },
        pricing,
      ),
    ).toBe(18);
  });

  it("bills cached input at the cached rate without double counting", () => {
    // 600k uncached * $3 + 400k cached * $0.30 = $1.80 + $0.12
    expect(
      calculateCostUsd(
        { inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 400_000 },
        pricing,
      ),
    ).toBe(1.92);
  });

  it("falls back to the input rate when no cached rate exists", () => {
    expect(
      calculateCostUsd(
        { inputTokens: 1_000, outputTokens: 0, cachedInputTokens: 1_000 },
        {
          inputPerMTokUsd: 2,
          outputPerMTokUsd: 8,
          cachedInputPerMTokUsd: null,
        },
      ),
    ).toBe(0.002);
  });

  it("rounds to six decimal places", () => {
    expect(
      calculateCostUsd(
        { inputTokens: 1, outputTokens: 1 },
        { inputPerMTokUsd: 0.15, outputPerMTokUsd: 0.6 },
      ),
    ).toBe(0.000001);
  });

  it("returns zero for zero usage", () => {
    expect(calculateCostUsd({ inputTokens: 0, outputTokens: 0 }, pricing)).toBe(
      0,
    );
  });

  it.each([
    [{ inputTokens: -1, outputTokens: 0 }],
    [{ inputTokens: 1.5, outputTokens: 0 }],
    [{ inputTokens: 10, outputTokens: 0, cachedInputTokens: 11 }],
  ])("rejects invalid usage %o", (usage) => {
    expect(() => calculateCostUsd(usage, pricing)).toThrow(RangeError);
  });

  it("rejects negative prices", () => {
    expect(() =>
      calculateCostUsd(
        { inputTokens: 1, outputTokens: 1 },
        { inputPerMTokUsd: -1, outputPerMTokUsd: 1 },
      ),
    ).toThrow(RangeError);
  });
});

describe("formatUsd", () => {
  it("formats with at least two and at most four decimals", () => {
    expect(formatUsd(12)).toBe("$12.00");
    expect(formatUsd(0.123456)).toBe("$0.1235");
  });
});

describe("calculateCostUsd with cache writes", () => {
  // Claude Haiku 5.5 short-prompt rates: $0.10 in, $0.01 cache hit,
  // $0.125 cache write, $0.50 out.
  const haiku = {
    inputPerMTokUsd: 0.1,
    outputPerMTokUsd: 0.5,
    cachedInputPerMTokUsd: 0.01,
    cacheWritePerMTokUsd: 0.125,
  };

  it("bills uncached, cached and cache-write input at their own rates", () => {
    // 20k uncached * $0.10 + 50k cached * $0.01 + 30k writes * $0.125
    // + 10k out * $0.50 = 0.002 + 0.0005 + 0.00375 + 0.005
    expect(
      calculateCostUsd(
        {
          inputTokens: 100_000,
          cachedInputTokens: 50_000,
          cacheWriteInputTokens: 30_000,
          outputTokens: 10_000,
        },
        haiku,
      ),
    ).toBe(0.01125);
  });

  it("bills cache writes at the input rate when there's no write price", () => {
    expect(
      calculateCostUsd(
        {
          inputTokens: 1_000_000,
          cacheWriteInputTokens: 1_000_000,
          outputTokens: 0,
        },
        { inputPerMTokUsd: 2, outputPerMTokUsd: 8 },
      ),
    ).toBe(2);
  });

  it("rejects cached plus cache-write tokens above input tokens", () => {
    expect(() =>
      calculateCostUsd(
        {
          inputTokens: 10,
          cachedInputTokens: 6,
          cacheWriteInputTokens: 5,
          outputTokens: 0,
        },
        haiku,
      ),
    ).toThrow(RangeError);
  });

  it("rejects negative cache-write tokens", () => {
    expect(() =>
      calculateCostUsd(
        { inputTokens: 10, cacheWriteInputTokens: -1, outputTokens: 0 },
        haiku,
      ),
    ).toThrow(RangeError);
  });
});

describe("calculateCostUsd with a prompt-length tier", () => {
  // Claude Haiku 5.5: higher rates for prompts over 100,000 tokens.
  const tiered = {
    inputPerMTokUsd: 0.1,
    outputPerMTokUsd: 0.5,
    cachedInputPerMTokUsd: 0.01,
    cacheWritePerMTokUsd: 0.125,
    longContext: {
      thresholdTokens: 100_000,
      inputPerMTokUsd: 0.5,
      outputPerMTokUsd: 2.5,
      cachedInputPerMTokUsd: 0.05,
      cacheWritePerMTokUsd: 0.625,
    },
  };
  const cost = (inputTokens: number, extra: object = {}) =>
    calculateCostUsd(
      { inputTokens, outputTokens: 1_000_000, ...extra },
      tiered,
    );

  it("uses the base rates below the threshold", () => {
    // 50,000 * $0.10 + 1M out * $0.50, per 1M
    expect(cost(50_000)).toBe(0.505);
  });

  it("uses the base rates exactly at the threshold", () => {
    // 100,000 * $0.10 + 1M * $0.50
    expect(cost(100_000)).toBe(0.51);
  });

  it("uses the long rates for the whole request above the threshold", () => {
    // 200,000 * $0.50 + 1M out * $2.50: output pays the long rate too
    expect(cost(200_000)).toBe(2.6);
  });

  it("counts cached tokens toward the prompt length", () => {
    // Only 50,000 uncached, but 150,000 input in total is over 100,000:
    // 50,000 * $0.50 + 100,000 cached * $0.05 + 1M * $2.50
    expect(cost(150_000, { cachedInputTokens: 100_000 })).toBe(2.53);
  });

  it("bills long-prompt cache writes at the long write rate", () => {
    // 100,000 * $0.50 + 100,000 writes * $0.625 + 1M * $2.50
    expect(cost(200_000, { cacheWriteInputTokens: 100_000 })).toBe(2.6125);
  });

  it("falls back to the long input rate for long cached and write tokens", () => {
    const partial = {
      ...tiered,
      longContext: {
        thresholdTokens: 10,
        inputPerMTokUsd: 1,
        outputPerMTokUsd: 0,
      },
    };
    expect(
      calculateCostUsd(
        {
          inputTokens: 1_000_000,
          cachedInputTokens: 500_000,
          cacheWriteInputTokens: 500_000,
          outputTokens: 0,
        },
        partial,
      ),
    ).toBe(1);
  });

  it("ignores a null long tier", () => {
    expect(
      calculateCostUsd(
        { inputTokens: 1_000_000, outputTokens: 0 },
        { inputPerMTokUsd: 3, outputPerMTokUsd: 15, longContext: null },
      ),
    ).toBe(3);
  });
});

describe("ratesForUsage", () => {
  const pricing = {
    inputPerMTokUsd: 1,
    outputPerMTokUsd: 2,
    longContext: {
      thresholdTokens: 5,
      inputPerMTokUsd: 3,
      outputPerMTokUsd: 4,
    },
  };

  it.each([
    [4, 1],
    [5, 1],
    [6, 3],
  ])("with %d input tokens uses input rate %d", (inputTokens, rate) => {
    expect(ratesForUsage({ inputTokens }, pricing).inputPerMTokUsd).toBe(rate);
  });
});
