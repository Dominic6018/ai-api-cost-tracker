import { describe, expect, it } from "vitest";
import {
  budgetUtilization,
  formatMicrosUsd,
  formatUsedPercent,
  microsToUsd,
  toMicros,
} from "./budget";

function withBudget(spent: string, budget: string) {
  const result = budgetUtilization(spent, budget);
  if (!result.hasBudget) throw new Error("expected a budget");
  return result;
}

describe("toMicros", () => {
  it.each([
    ["0", 0n],
    ["100", 100_000_000n],
    ["100.00", 100_000_000n],
    ["0.000001", 1n],
    ["12.5", 12_500_000n],
    [" 3.420000 ", 3_420_000n],
    ["9999999999.99", 9_999_999_999_990_000n],
  ])("parses %j", (usd, micros) => {
    expect(toMicros(usd)).toBe(micros);
  });

  it("drops digits past six decimals instead of rounding", () => {
    expect(toMicros("1.0000009")).toBe(1_000_000n);
  });

  it.each(["", "-1", "abc", "1e3", "$5", "1.2.3"])("rejects %j", (usd) => {
    expect(() => toMicros(usd)).toThrow(TypeError);
  });

  it("converts back to dollars", () => {
    expect(microsToUsd(3_420_000n)).toBe(3.42);
  });
});

describe("budgetUtilization", () => {
  it("reports spend only when there's no budget", () => {
    expect(budgetUtilization("3.10", null)).toEqual({
      hasBudget: false,
      spentMicros: 3_100_000n,
    });
  });

  it("computes the share used and what remains", () => {
    expect(withBudget("25", "100")).toEqual({
      hasBudget: true,
      spentMicros: 25_000_000n,
      budgetMicros: 100_000_000n,
      remainingMicros: 75_000_000n,
      usedPermille: 250,
      overBudget: false,
    });
  });

  it("rounds the percentage down, so it never shows 100% early", () => {
    const almost = withBudget("99.999999", "100");
    expect(almost.usedPermille).toBe(999);
    expect(almost.overBudget).toBe(false);
    expect(formatUsedPercent(almost)).toBe("99.9%");
  });

  it("treats spending exactly the budget as used up but not over", () => {
    const exact = withBudget("100.000000", "100.00");
    expect(exact.usedPermille).toBe(1000);
    expect(exact.remainingMicros).toBe(0n);
    expect(exact.overBudget).toBe(false);
  });

  it("flags spend over budget, with negative remaining", () => {
    const over = withBudget("150.000001", "100");
    expect(over.overBudget).toBe(true);
    expect(over.usedPermille).toBe(1500);
    expect(over.remainingMicros).toBe(-50_000_001n);
    expect(formatUsedPercent(over)).toBe("150.0%");
  });

  it("is over by a single micro-dollar", () => {
    expect(withBudget("100.000001", "100").overBudget).toBe(true);
  });

  it("handles a zero budget with no spend as 0% used", () => {
    const zero = withBudget("0", "0");
    expect(zero.usedPermille).toBe(0);
    expect(zero.overBudget).toBe(false);
    expect(formatUsedPercent(zero)).toBe("0.0%");
  });

  it("handles a zero budget with spend as over, without a percentage", () => {
    const zero = withBudget("0.000001", "0.00");
    expect(zero.usedPermille).toBeNull();
    expect(zero.overBudget).toBe(true);
    expect(formatUsedPercent(zero)).toBe("—");
  });

  it("shows <0.1% for tiny non-zero use", () => {
    expect(formatUsedPercent(withBudget("0.006", "100"))).toBe("<0.1%");
    expect(formatUsedPercent(withBudget("0", "100"))).toBe("0.0%");
  });

  it("works at the largest budget the column allows", () => {
    const big = withBudget("9999999999.99", "9999999999.99");
    expect(big.usedPermille).toBe(1000);
    expect(big.overBudget).toBe(false);
  });
});

describe("formatMicrosUsd", () => {
  const format = (usd: number) => `$${usd.toFixed(4)}`;

  it("shows tiny non-zero amounts as <$0.0001 instead of zero", () => {
    expect(formatMicrosUsd(1n, format)).toBe("<$0.0001");
    expect(formatMicrosUsd(99n, format)).toBe("<$0.0001");
  });

  it("formats zero and displayable amounts normally", () => {
    expect(formatMicrosUsd(0n, format)).toBe("$0.0000");
    expect(formatMicrosUsd(100n, format)).toBe("$0.0001");
    expect(formatMicrosUsd(3_420_000n, format)).toBe("$3.4200");
  });
});
