import { describe, expect, it } from "vitest";
import {
  calculateCostUsd,
  formatUsd,
  hasAudio,
  ratesForUsage,
  webSearchCostMicros,
} from "./cost";

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

describe("calculateCostUsd with 1-hour cache writes", () => {
  // Claude Sonnet 5.5, per 1M tokens: $2 input, $2.50 5-minute writes,
  // $4 1-hour writes, $10 output.
  const sonnet = {
    inputPerMTokUsd: 2,
    outputPerMTokUsd: 10,
    cachedInputPerMTokUsd: 0.1,
    cacheWritePerMTokUsd: 2.5,
    cacheWrite1hPerMTokUsd: 4,
  };

  it("bills 1-hour writes at their rate and the rest at the 5-minute rate", () => {
    // 4,000 × $2 + 2,000 × $2.50 + 4,000 × $4 = $0.029
    expect(
      calculateCostUsd(
        {
          inputTokens: 10_000,
          outputTokens: 0,
          cacheWriteInputTokens: 6_000,
          cacheWrite1hInputTokens: 4_000,
        },
        sonnet,
      ),
    ).toBe(0.029);
  });

  it("is unchanged for usage without 1-hour writes", () => {
    const usage = {
      inputTokens: 10_000,
      outputTokens: 1_000,
      cacheWriteInputTokens: 6_000,
    };
    // 4,000 × $2 + 6,000 × $2.50 + 1,000 × $10 = $0.033
    expect(calculateCostUsd(usage, sonnet)).toBe(0.033);
    expect(
      calculateCostUsd({ ...usage, cacheWrite1hInputTokens: 0 }, sonnet),
    ).toBe(0.033);
  });

  it("falls back to the 5-minute rate, then input, without a 1-hour rate", () => {
    const usage = {
      inputTokens: 10_000,
      outputTokens: 0,
      cacheWriteInputTokens: 6_000,
      cacheWrite1hInputTokens: 4_000,
    };
    // 4,000 × $2 + 6,000 × $2.50 = $0.023
    expect(
      calculateCostUsd(usage, { ...sonnet, cacheWrite1hPerMTokUsd: null }),
    ).toBe(0.023);
    // Every input token at $2 = $0.02
    expect(
      calculateCostUsd(usage, {
        inputPerMTokUsd: 2,
        outputPerMTokUsd: 10,
      }),
    ).toBe(0.02);
  });

  it("uses the long tier's 1-hour rate for long prompts", () => {
    // Claude Haiku 5.5 over 100,000 tokens: $0.50 input, $1 1-hour writes.
    const haiku = {
      inputPerMTokUsd: 0.1,
      outputPerMTokUsd: 0.5,
      cacheWritePerMTokUsd: 0.125,
      cacheWrite1hPerMTokUsd: 0.2,
      longContext: {
        thresholdTokens: 100_000,
        inputPerMTokUsd: 0.5,
        outputPerMTokUsd: 2.5,
        cacheWritePerMTokUsd: 0.625,
        cacheWrite1hPerMTokUsd: 1,
      },
    };
    // 100,000 × $0.50 + 50,000 × $1 = $0.10
    expect(
      calculateCostUsd(
        {
          inputTokens: 150_000,
          outputTokens: 0,
          cacheWriteInputTokens: 50_000,
          cacheWrite1hInputTokens: 50_000,
        },
        haiku,
      ),
    ).toBe(0.1);
  });

  it("rejects more 1-hour writes than writes", () => {
    expect(() =>
      calculateCostUsd(
        {
          inputTokens: 10_000,
          outputTokens: 0,
          cacheWriteInputTokens: 1_000,
          cacheWrite1hInputTokens: 1_001,
        },
        sonnet,
      ),
    ).toThrow(RangeError);
  });
});

describe("calculateCostUsd for batch usage", () => {
  // Claude Sonnet 5.5 with Anthropic's 50% Batch API price.
  const sonnet = {
    inputPerMTokUsd: 2,
    outputPerMTokUsd: 10,
    cachedInputPerMTokUsd: 0.1,
    cacheWritePerMTokUsd: 2.5,
    cacheWrite1hPerMTokUsd: 4,
    batchMultiplier: 0.5,
  };
  const usage = {
    inputTokens: 10_000,
    outputTokens: 1_000,
    cachedInputTokens: 2_000,
    cacheWriteInputTokens: 4_000,
    cacheWrite1hInputTokens: 1_000,
  };

  it("costs the multiplier times the standard price, cache rates included", () => {
    // Standard: 4,000 × $2 + 2,000 × $0.10 + 3,000 × $2.50 + 1,000 × $4
    // + 1,000 × $10 = $0.0297; batch is half of that.
    expect(calculateCostUsd(usage, sonnet)).toBe(0.0297);
    expect(
      calculateCostUsd({ ...usage, serviceTier: "standard" }, sonnet),
    ).toBe(0.0297);
    expect(calculateCostUsd({ ...usage, serviceTier: "batch" }, sonnet)).toBe(
      0.01485,
    );
  });

  it("halves the long tier too", () => {
    const haiku = {
      inputPerMTokUsd: 0.1,
      outputPerMTokUsd: 0.5,
      longContext: {
        thresholdTokens: 100_000,
        inputPerMTokUsd: 0.5,
        outputPerMTokUsd: 2.5,
      },
      batchMultiplier: 0.5,
    };
    // 150,000 × $0.50 + 1,000 × $2.50 = $0.0775, halved.
    expect(
      calculateCostUsd(
        { inputTokens: 150_000, outputTokens: 1_000, serviceTier: "batch" },
        haiku,
      ),
    ).toBe(0.03875);
  });

  it("rounds once, after the discount", () => {
    // 1 input token at $3 is $0.000003; half is $0.0000015, rounded to
    // $0.000002 once, not $0.000003 × 0.5 of an already-rounded amount.
    expect(
      calculateCostUsd(
        { inputTokens: 1, outputTokens: 0, serviceTier: "batch" },
        { inputPerMTokUsd: 3, outputPerMTokUsd: 15, batchMultiplier: 0.5 },
      ),
    ).toBe(0.000002);
  });

  it("rounds an exact half micro-dollar up, despite float noise", () => {
    // $0.000855 halved is exactly $0.0004275, but the nearest float is
    // 0.00042749999…, so plain rounding goes down. FOCUS's exact
    // arithmetic rounds it up, and the recorded cost must agree.
    expect((0.000855 * 0.5).toFixed(6)).toBe("0.000427");
    expect(
      calculateCostUsd(
        { inputTokens: 1, outputTokens: 0, serviceTier: "batch" },
        { inputPerMTokUsd: 855, outputPerMTokUsd: 0, batchMultiplier: 0.5 },
      ),
    ).toBe(0.000428);
  });

  it("refuses batch usage without a batch price, or with a bad one", () => {
    const batch = { ...usage, serviceTier: "batch" as const };
    expect(() =>
      calculateCostUsd(batch, { ...sonnet, batchMultiplier: null }),
    ).toThrow(/No batch price/);
    expect(() =>
      calculateCostUsd(batch, { ...sonnet, batchMultiplier: 1.5 }),
    ).toThrow(RangeError);
    // Standard usage doesn't need one.
    expect(calculateCostUsd(usage, { ...sonnet, batchMultiplier: null })).toBe(
      0.0297,
    );
  });
});

describe("webSearchCostMicros", () => {
  it("charges the per-1,000 price for each search, exactly", () => {
    expect(webSearchCostMicros(1, "10")).toBe(10_000n);
    expect(webSearchCostMicros(3, "10.000000")).toBe(30_000n);
    expect(webSearchCostMicros(0, "10")).toBe(0n);
    expect(webSearchCostMicros(1_000_000, "10")).toBe(10_000_000_000n);
  });

  it("rounds a fraction of a micro-dollar half up", () => {
    // 1 search at $0.0015 per 1,000 is 1.5 micro-dollars.
    expect(webSearchCostMicros(1, "0.0015")).toBe(2n);
    expect(webSearchCostMicros(1, "0.0014")).toBe(1n);
  });

  it("rejects negative or fractional counts", () => {
    expect(() => webSearchCostMicros(-1, "10")).toThrow();
    expect(() => webSearchCostMicros(1.5, "10")).toThrow();
  });
});

describe("audio tokens", () => {
  // gpt-realtime-2.1: text $4 / $0.40 cached / $24 out; audio $32 / $0.40 / $64.
  const realtime = {
    inputPerMTokUsd: 4,
    outputPerMTokUsd: 24,
    cachedInputPerMTokUsd: 0.4,
    audio: {
      inputPerMTokUsd: 32,
      cachedInputPerMTokUsd: 0.4,
      outputPerMTokUsd: 64,
    },
  };

  it("bills audio at the audio rates and the rest as text", () => {
    // Text: 1,000 uncached × $4 + 500 cached × $0.40 + 200 out × $24
    // Audio: 2,000 uncached × $32 + 1,000 cached × $0.40 + 800 out × $64
    const usage = {
      inputTokens: 4_500,
      cachedInputTokens: 1_500,
      audioInputTokens: 3_000,
      cachedAudioInputTokens: 1_000,
      outputTokens: 1_000,
      audioOutputTokens: 800,
    };
    expect(calculateCostUsd(usage, realtime)).toBe(0.124_6);
  });

  it("falls back to the audio input rate for cached audio", () => {
    const noCache = {
      ...realtime,
      audio: { inputPerMTokUsd: 32, outputPerMTokUsd: 64 },
    };
    expect(
      calculateCostUsd(
        {
          inputTokens: 1_000,
          cachedInputTokens: 1_000,
          audioInputTokens: 1_000,
          cachedAudioInputTokens: 1_000,
          outputTokens: 0,
        },
        noCache,
      ),
    ).toBe(0.032);
  });

  it("applies the batch multiplier to audio too", () => {
    expect(
      calculateCostUsd(
        {
          inputTokens: 1_000_000,
          audioInputTokens: 1_000_000,
          outputTokens: 0,
          serviceTier: "batch",
        },
        { ...realtime, batchMultiplier: 0.5 },
      ),
    ).toBe(16);
  });

  it("keeps audio rates for long prompts", () => {
    const tiered = {
      ...realtime,
      longContext: {
        thresholdTokens: 10,
        inputPerMTokUsd: 8,
        outputPerMTokUsd: 48,
      },
    };
    // 1,000 audio at $32 and 1,000 text at the long $8.
    expect(
      calculateCostUsd(
        { inputTokens: 2_000, audioInputTokens: 1_000, outputTokens: 0 },
        tiered,
      ),
    ).toBe(0.04);
  });

  it("throws without audio rates, and for impossible splits", () => {
    const textOnly = { ...realtime, audio: null };
    expect(() =>
      calculateCostUsd(
        { inputTokens: 10, outputTokens: 10, audioOutputTokens: 1 },
        textOnly,
      ),
    ).toThrow(/audio price/);
    expect(hasAudio({ inputTokens: 1, outputTokens: 1 })).toBe(false);
    expect(
      hasAudio({ inputTokens: 1, outputTokens: 1, audioOutputTokens: 1 }),
    ).toBe(true);
    for (const usage of [
      { inputTokens: 10, outputTokens: 0, audioOutputTokens: 1 },
      { inputTokens: 10, outputTokens: 0, audioInputTokens: 11 },
      {
        inputTokens: 10,
        outputTokens: 0,
        audioInputTokens: 5,
        cachedAudioInputTokens: 6,
      },
      {
        inputTokens: 10,
        outputTokens: 0,
        cachedInputTokens: 2,
        audioInputTokens: 5,
        cachedAudioInputTokens: 3,
      },
      {
        inputTokens: 10,
        outputTokens: 0,
        cachedInputTokens: 8,
        audioInputTokens: 5,
      },
    ]) {
      expect(() => calculateCostUsd(usage, realtime)).toThrow(RangeError);
    }
  });
});
