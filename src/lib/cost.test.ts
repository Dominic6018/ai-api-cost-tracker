import { describe, expect, it } from "vitest";
import { calculateCostUsd, formatUsd } from "./cost";

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
