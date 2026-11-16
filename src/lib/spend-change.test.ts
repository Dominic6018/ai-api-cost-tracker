import { describe, expect, it } from "vitest";
import {
  comparisonPeriods,
  EFFECTS,
  explainSpendChange,
  parseComparison,
  type ModelInput,
  type ModelUsage,
} from "./spend-change";

const usage = (requests: number, tokens: number, costMicros: number) => ({
  requests: BigInt(requests),
  tokens: BigInt(tokens),
  costMicros: BigInt(costMicros),
});

const model = (
  name: string,
  before: ModelUsage | null,
  after: ModelUsage | null,
): ModelInput => ({ provider: "openai", model: name, before, after });

const sumOf = (effects: Record<string, bigint>) =>
  Object.values(effects).reduce((a, b) => a + b, 0n);

describe("explainSpendChange", () => {
  it("splits a change into volume, model mix, tokens per request and cost per token", () => {
    // Before: 100 requests on A at $1 each (1,000 tokens each).
    // After: 150 requests, 90 on A and 60 on B; A's requests are 20%
    // longer and its tokens 10% dearer; B costs $2 a request.
    const result = explainSpendChange([
      model(
        "a",
        usage(100, 100_000, 100_000_000),
        usage(90, 108_000, 118_800_000),
      ),
      model("b", null, usage(60, 60_000, 120_000_000)),
    ]);
    expect(result.changeMicros).toBe(138_800_000n);
    expect(result.effects).toEqual({
      // 50% more requests at the old cost: $150 - $100.
      volume: 50_000_000n,
      // 90 on A at $1 ($90) plus B's $120, against $150.
      modelMix: 60_000_000n,
      // A's 108,000 tokens at $0.001 = $108, against $90.
      tokensPerRequest: 18_000_000n,
      // A's actual $118.80 against $108; without prices it's all other.
      inputOutputMix: 0n,
      cacheRate: 0n,
      price: 0n,
      other: 10_800_000n,
    });
    expect(sumOf(result.effects)).toBe(result.changeMicros);
    expect(result.models.map((m) => m.model)).toEqual(["b", "a"]);
  });

  it("puts a dropped model's spend in model mix", () => {
    const result = explainSpendChange([
      model("a", usage(10, 1000, 10_000_000), usage(20, 2000, 20_000_000)),
      model("old", usage(10, 1000, 30_000_000), null),
    ]);
    expect(result.effects).toEqual({
      // Same number of requests overall.
      volume: 0n,
      // 20 requests on A at $1 = $20, against the $40 before.
      modelMix: -20_000_000n,
      tokensPerRequest: 0n,
      inputOutputMix: 0n,
      cacheRate: 0n,
      price: 0n,
      other: 0n,
    });
    expect(result.changeMicros).toBe(-20_000_000n);
  });

  it("counts everything as volume when the earlier period had no usage", () => {
    const result = explainSpendChange([
      model("a", null, usage(5, 500, 7_000_000)),
    ]);
    expect(result.effects).toEqual({
      volume: 7_000_000n,
      modelMix: 0n,
      tokensPerRequest: 0n,
      inputOutputMix: 0n,
      cacheRate: 0n,
      price: 0n,
      other: 0n,
    });
  });

  it("splits cost per token into input/output mix, cache rate and price", () => {
    const rates = (output: number) => ({
      inputPerMTokUsd: 2,
      cachedInputPerMTokUsd: 0.5,
      outputPerMTokUsd: output,
    });
    const parts = (input: number, cached: number, output: number) => ({
      input: BigInt(input),
      cached: BigInt(cached),
      writes: 0n,
      writes1h: 0n,
      output: BigInt(output),
    });
    // Before: 1M input, none cached, 100k output, at $2 / $8: $2.80.
    // After: half the input cached, twice the output, output now $10:
    // $1.00 + $0.25 + $2.00 = $3.25.
    const result = explainSpendChange(
      [
        model(
          "a",
          {
            ...usage(100, 1_100_000, 2_800_000),
            parts: parts(1_000_000, 0, 100_000),
          },
          {
            ...usage(100, 1_200_000, 3_250_000),
            parts: parts(1_000_000, 500_000, 200_000),
          },
        ),
      ],
      new Map([["openai/a", { before: rates(8), after: rates(10) }]]),
    );
    expect(result.effects).toEqual({
      volume: 0n,
      modelMix: 0n,
      // 1.2M tokens at the earlier $2.80 per 1.1M.
      tokensPerRequest: 254_545n,
      // 200k output instead of 100k-in-1.1M's share, at the old rates: $3.60.
      inputOutputMix: 545_455n,
      // Half the input cached, at the old rates: $2.85.
      cacheRate: -750_000n,
      // The same tokens at the new output rate: $3.25.
      price: 400_000n,
      // The rates model these costs exactly.
      other: 0n,
    });
    expect(sumOf(result.effects)).toBe(450_000n);
  });

  it("leaves cost per token as other without a price for both periods", () => {
    const parts = {
      input: 900n,
      cached: 0n,
      writes: 0n,
      writes1h: 0n,
      output: 100n,
    };
    const result = explainSpendChange(
      [
        model(
          "a",
          { ...usage(1, 1000, 1_000_000), parts },
          { ...usage(1, 1000, 1_500_000), parts },
        ),
      ],
      new Map([
        [
          "openai/a",
          { before: null, after: { inputPerMTokUsd: 1, outputPerMTokUsd: 1 } },
        ],
      ]),
    );
    expect(result.effects).toMatchObject({
      inputOutputMix: 0n,
      cacheRate: 0n,
      price: 0n,
      other: 500_000n,
    });
  });

  it("explains nothing when nothing changed", () => {
    const same = usage(3, 300, 4_000_000);
    const result = explainSpendChange([model("a", same, same)]);
    expect(result.changeMicros).toBe(0n);
    expect(Object.values(result.effects).every((v) => v === 0n)).toBe(true);
  });

  it("always adds up to the change exactly, whatever the rounding", () => {
    // Awkward numbers: thirds and sevenths of micro-dollars everywhere.
    let seed = 7;
    const next = (max: number) => {
      seed = (seed * 48271) % 2147483647;
      return seed % max;
    };
    for (let i = 0; i < 200; i++) {
      const inputs = Array.from({ length: 1 + next(5) }, (_, k) =>
        model(
          `m${k}`,
          next(4) === 0
            ? null
            : usage(1 + next(97), next(10_001), next(9_999_999)),
          next(4) === 0
            ? null
            : usage(1 + next(89), next(10_001), next(9_999_999)),
        ),
      );
      // Token kinds and prices for some models, so repricing is tested too.
      const prices = new Map();
      for (const m of inputs) {
        for (const u of [m.before, m.after]) {
          if (u && next(2) === 0) {
            const input = (u.tokens * BigInt(next(100))) / 100n;
            const cached = (input * BigInt(next(100))) / 100n;
            const writes = ((input - cached) * BigInt(next(100))) / 100n;
            Object.assign(u, {
              parts: {
                input,
                cached,
                writes,
                writes1h: (writes * BigInt(next(100))) / 100n,
                output: u.tokens - input,
              },
            });
          }
        }
        const rate = () => ({
          inputPerMTokUsd: next(1000) / 100,
          outputPerMTokUsd: next(4000) / 100,
          cachedInputPerMTokUsd: next(3) === 0 ? null : next(100) / 100,
          cacheWritePerMTokUsd: next(3) === 0 ? null : next(500) / 100,
        });
        prices.set(`openai/${m.model}`, {
          before: next(5) === 0 ? null : rate(),
          after: rate(),
        });
      }
      const result = explainSpendChange(inputs, prices);
      expect(sumOf(result.effects)).toBe(result.changeMicros);
      for (const m of result.models) {
        expect(sumOf(m.effects)).toBe(m.changeMicros);
      }
      for (const effect of EFFECTS) {
        expect(result.models.reduce((s, m) => s + m.effects[effect], 0n)).toBe(
          result.effects[effect],
        );
      }
    }
  });
});

describe("comparisonPeriods", () => {
  const now = new Date("2026-11-17T15:30:00Z");

  it("compares whole days, leaving out today", () => {
    expect(comparisonPeriods(now, "7d")).toEqual({
      before: {
        from: new Date("2026-11-03T00:00:00Z"),
        to: new Date("2026-11-10T00:00:00Z"),
      },
      after: {
        from: new Date("2026-11-10T00:00:00Z"),
        to: new Date("2026-11-17T00:00:00Z"),
      },
    });
    const days30 = comparisonPeriods(now, "30d");
    expect(days30.after.from).toEqual(new Date("2026-10-18T00:00:00Z"));
    expect(days30.before.from).toEqual(new Date("2026-09-18T00:00:00Z"));
  });

  it("compares the last two finished months, across a year", () => {
    expect(
      comparisonPeriods(new Date("2027-01-05T00:00:00Z"), "month"),
    ).toEqual({
      before: {
        from: new Date("2026-11-01T00:00:00Z"),
        to: new Date("2026-12-01T00:00:00Z"),
      },
      after: {
        from: new Date("2026-12-01T00:00:00Z"),
        to: new Date("2027-01-01T00:00:00Z"),
      },
    });
  });

  it("falls back to 30 days for anything else", () => {
    expect(parseComparison("month")).toBe("month");
    expect(parseComparison(["7d"])).toBe("7d");
    expect(parseComparison("year")).toBe("30d");
    expect(parseComparison(undefined)).toBe("30d");
  });
});
