import { describe, expect, it } from "vitest";
import {
  isEffectiveAt,
  selectEffectivePricing,
  toTokenPricing,
  type PricingRow,
} from "./pricing";

function row(
  from: string,
  to: string | null,
  input = "3",
  overrides: Partial<PricingRow> = {},
): PricingRow {
  return {
    effectiveFrom: new Date(from),
    effectiveTo: to === null ? null : new Date(to),
    inputPerMTokUsd: input,
    outputPerMTokUsd: "15",
    cachedInputPerMTokUsd: null,
    ...overrides,
  };
}

const jan = "2026-01-01T00:00:00Z";
const feb = "2026-02-01T00:00:00Z";
const mar = "2026-03-01T00:00:00Z";

describe("isEffectiveAt", () => {
  const closed = row(jan, feb);

  it("includes effective_from", () => {
    expect(isEffectiveAt(closed, new Date(jan))).toBe(true);
  });

  it("excludes effective_to", () => {
    expect(isEffectiveAt(closed, new Date(feb))).toBe(false);
  });

  it("excludes times before effective_from", () => {
    expect(isEffectiveAt(closed, new Date("2025-12-31T23:59:59Z"))).toBe(false);
  });

  it("treats a null effective_to as open-ended", () => {
    expect(
      isEffectiveAt(row(jan, null), new Date("2030-01-01T00:00:00Z")),
    ).toBe(true);
  });
});

describe("selectEffectivePricing", () => {
  const history = [row(jan, feb, "3"), row(feb, mar, "2"), row(mar, null, "1")];

  it.each([
    ["2026-01-15T00:00:00Z", 3],
    [feb, 2],
    ["2026-02-28T23:59:59.999Z", 2],
    [mar, 1],
    ["2027-06-01T00:00:00Z", 1],
  ])("at %s picks the price of %d", (at, expected) => {
    const result = selectEffectivePricing(history, new Date(at));
    expect(result.found && result.pricing.inputPerMTokUsd).toBe(expected);
  });

  it("is independent of row order", () => {
    const result = selectEffectivePricing(
      [...history].reverse(),
      new Date("2026-01-15T00:00:00Z"),
    );
    expect(result.found && result.pricing.inputPerMTokUsd).toBe(3);
  });

  it("prefers the most recently started price when ranges overlap", () => {
    const result = selectEffectivePricing(
      [row(jan, null, "3"), row(feb, null, "2")],
      new Date("2026-02-15T00:00:00Z"),
    );
    expect(result.found && result.pricing.inputPerMTokUsd).toBe(2);
  });

  it("returns the matching row", () => {
    const result = selectEffectivePricing(history, new Date(feb));
    expect(result.found && result.row).toBe(history[1]);
  });

  it("returns not found before the first price", () => {
    expect(selectEffectivePricing(history, new Date("2025-06-01"))).toEqual({
      found: false,
      reason: "no_pricing",
    });
  });

  it("returns not found in a gap between prices", () => {
    expect(
      selectEffectivePricing(
        [row(jan, feb), row(mar, null)],
        new Date("2026-02-15T00:00:00Z"),
      ),
    ).toEqual({ found: false, reason: "no_pricing" });
  });

  it("returns not found for an empty history", () => {
    expect(selectEffectivePricing([], new Date(jan)).found).toBe(false);
  });
});

describe("toTokenPricing", () => {
  it("parses numeric strings, keeping a null cached rate", () => {
    expect(
      toTokenPricing(
        row(jan, null, "3.000000", { outputPerMTokUsd: "15.500000" }),
      ),
    ).toEqual({
      inputPerMTokUsd: 3,
      outputPerMTokUsd: 15.5,
      cachedInputPerMTokUsd: null,
    });
  });

  it("parses a cached rate when present", () => {
    expect(
      toTokenPricing(row(jan, null, "3", { cachedInputPerMTokUsd: "0.300000" }))
        .cachedInputPerMTokUsd,
    ).toBe(0.3);
  });

  it.each(["", "abc", "NaN"])("rejects the invalid value %j", (value) => {
    expect(() => toTokenPricing(row(jan, null, value))).toThrow(TypeError);
  });
});
