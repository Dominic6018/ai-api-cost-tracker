import { describe, expect, it } from "vitest";
import {
  comparisonPeriods,
  EFFECTS,
  explainSpendChange,
  parseComparison,
  type ModelInput,
} from "./spend-change";

const usage = (requests: number, tokens: number, costMicros: number) => ({
  requests: BigInt(requests),
  tokens: BigInt(tokens),
  costMicros: BigInt(costMicros),
});

const model = (
  name: string,
  before: ReturnType<typeof usage> | null,
  after: ReturnType<typeof usage> | null,
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
      // A's actual $118.80 against $108.
      costPerToken: 10_800_000n,
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
      costPerToken: 0n,
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
      costPerToken: 0n,
    });
  });

  it("explains nothing when nothing changed", () => {
    const same = usage(3, 300, 4_000_000);
    const result = explainSpendChange([model("a", same, same)]);
    expect(result.changeMicros).toBe(0n);
    expect(Object.values(result.effects)).toEqual([0n, 0n, 0n, 0n]);
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
      const result = explainSpendChange(inputs);
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
