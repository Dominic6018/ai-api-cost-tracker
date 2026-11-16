import { describe, expect, it } from "vitest";
import {
  customerCreatedEntry,
  formatEntryUsd,
  ledgerEntryAudit,
  monthLabel,
  monthStart,
  monthlyCharges,
  nextMonth,
  parseBillingMonth,
  parsePlanAmount,
  parsePlanSlug,
  parseUsageMultiplier,
  subscriptionEntry,
  parseCustomerExternalId,
  parseEntryAmount,
  parseEntryDescription,
  parseSignedDecimal,
} from "./billing";

describe("parseEntryAmount", () => {
  it("reads charges and credits exactly, in micro-dollars", () => {
    expect(parseEntryAmount("12.5")).toEqual({ ok: true, value: 12_500_000n });
    expect(parseEntryAmount(" -0.000001 ")).toEqual({ ok: true, value: -1n });
    expect(parseEntryAmount("+3")).toEqual({ ok: true, value: 3_000_000n });
    expect(parseEntryAmount("99999999.999999")).toEqual({
      ok: true,
      value: 99_999_999_999_999n,
    });
  });

  it("refuses more than six decimals rather than rounding", () => {
    expect(parseEntryAmount("0.0000001").ok).toBe(false);
    expect(parseEntryAmount("1.2345678").ok).toBe(false);
  });

  it("refuses zero, amounts too large to store, and non-numbers", () => {
    for (const text of [
      "0",
      "-0.000000",
      "100000000",
      "1e3",
      "",
      "$5",
      "1,000",
      ".",
    ]) {
      expect(parseEntryAmount(text).ok, text).toBe(false);
    }
  });
});

describe("parseSignedDecimal", () => {
  it("reads stored amounts and sums", () => {
    expect(parseSignedDecimal("0")).toBe(0n);
    expect(parseSignedDecimal("-3.250000")).toBe(-3_250_000n);
    expect(parseSignedDecimal("123456789.000001")).toBe(123_456_789_000_001n);
  });

  it("throws on anything else", () => {
    expect(() => parseSignedDecimal("NaN")).toThrow(TypeError);
    expect(() => parseSignedDecimal("1.0000001")).toThrow(TypeError);
  });
});

describe("text fields", () => {
  it("trims, and refuses empty or over-long values", () => {
    expect(parseCustomerExternalId("  cus_42 ")).toEqual({
      ok: true,
      value: "cus_42",
    });
    expect(parseCustomerExternalId("   ").ok).toBe(false);
    expect(parseCustomerExternalId("x".repeat(201)).ok).toBe(false);
    expect(parseEntryDescription("x".repeat(500)).ok).toBe(true);
    expect(parseEntryDescription("x".repeat(501)).ok).toBe(false);
  });
});

describe("formatEntryUsd", () => {
  it("shows the exact amount with its sign", () => {
    expect(formatEntryUsd(12_500_000n)).toBe("$12.500000");
    expect(formatEntryUsd(-1n)).toBe("-$0.000001");
    expect(formatEntryUsd(0n)).toBe("$0.000000");
  });
});

describe("audit entries", () => {
  it("names the customer and the entry, in the customer's organization", () => {
    expect(
      customerCreatedEntry({
        externalId: "cus_42",
        name: "Acme",
        organizationId: "org",
      }),
    ).toEqual({
      action: "billing.customer_created",
      target: "cus_42",
      details: { name: "Acme" },
      organizationId: "org",
    });
    expect(
      ledgerEntryAudit({
        id: "e2",
        kind: "reversal",
        amountUsd: "-5.000000",
        description: "Charged twice",
        reversesEntryId: "e1",
        organizationId: "org",
        customerExternalId: "cus_42",
      }),
    ).toEqual({
      action: "billing.reversed",
      target: "cus_42",
      details: {
        entryId: "e2",
        amountUsd: "-5.000000",
        description: "Charged twice",
        reversesEntryId: "e1",
      },
      organizationId: "org",
    });
  });
});

describe("plan fields", () => {
  it("reads fees and allowances exactly, zero allowed", () => {
    expect(parsePlanAmount("49", "The fee")).toEqual({
      ok: true,
      value: 49_000_000n,
    });
    expect(parsePlanAmount("0", "The fee")).toEqual({ ok: true, value: 0n });
    for (const text of ["-1", "0.0000001", "100000000", "$5", ""]) {
      expect(parsePlanAmount(text, "The fee").ok, text).toBe(false);
    }
  });

  it("keeps the usage multiplier as an exact decimal", () => {
    expect(parseUsageMultiplier("1.25")).toEqual({ ok: true, value: "1.2500" });
    expect(parseUsageMultiplier("0")).toEqual({ ok: true, value: "0.0000" });
    expect(parseUsageMultiplier("007")).toEqual({ ok: true, value: "7.0000" });
    for (const text of ["1.23456", "-1", "1e2", "1000000", ""]) {
      expect(parseUsageMultiplier(text).ok, text).toBe(false);
    }
  });

  it("accepts slugs like project slugs", () => {
    expect(parsePlanSlug("pro-2026")).toEqual({ ok: true, value: "pro-2026" });
    for (const text of ["Pro", "pro_plan", "-pro", "pro-", "a".repeat(65)]) {
      expect(parsePlanSlug(text).ok, text).toBe(false);
    }
  });
});

describe("billing months", () => {
  it("reads YYYY-MM as the first of the month", () => {
    expect(parseBillingMonth("2026-12")).toEqual({
      ok: true,
      value: "2026-12-01",
    });
    for (const text of ["2026-13", "2026-1", "2026-12-01", "Dec 2026"]) {
      expect(parseBillingMonth(text).ok, text).toBe(false);
    }
  });

  it("finds the current UTC month", () => {
    expect(monthStart(new Date("2026-11-30T23:59:59Z"))).toBe("2026-11-01");
    expect(monthStart(new Date("2026-12-01T00:00:00Z"))).toBe("2026-12-01");
    expect(monthLabel("2026-12-01")).toBe("2026-12");
  });

  it("audits plan changes with the month", () => {
    expect(
      subscriptionEntry({
        customerExternalId: "cus_42",
        planSlug: null,
        from: "2027-01-01",
        replaced: 1,
        organizationId: "org",
      }),
    ).toEqual({
      action: "billing.unsubscribed",
      target: "cus_42",
      details: { from: "2027-01", replaced: 1 },
      organizationId: "org",
    });
  });
});

describe("monthlyCharges", () => {
  const plan = {
    monthlyFeeUsd: "49.000000",
    includedUsageUsd: "20.000000",
    usageMultiplier: "1.2500",
  };

  it("charges usage beyond the allowance at the multiplier", () => {
    // $30 cost x 1.25 = $37.50, less $20 included = $17.50.
    expect(monthlyCharges(plan, 30_000_000n)).toEqual({
      feeMicros: 49_000_000n,
      usageChargeMicros: 37_500_000n,
      includedMicros: 20_000_000n,
      billableUsageMicros: 17_500_000n,
    });
  });

  it("charges nothing for usage within the allowance", () => {
    expect(monthlyCharges(plan, 16_000_000n).billableUsageMicros).toBe(0n);
    expect(monthlyCharges(plan, 0n).billableUsageMicros).toBe(0n);
    // Exactly the allowance: $16 x 1.25 = $20.
    expect(monthlyCharges(plan, 16_000_000n).usageChargeMicros).toBe(
      20_000_000n,
    );
  });

  it("rounds the usage charge half up to the micro-dollar, once", () => {
    const thirds = {
      ...plan,
      includedUsageUsd: "0",
      usageMultiplier: "1.3333",
    };
    // 1 micro x 1.3333 = 1.3333 -> 1; 3 micros x 1.3333 = 3.9999 -> 4.
    expect(monthlyCharges(thirds, 1n).usageChargeMicros).toBe(1n);
    expect(monthlyCharges(thirds, 3n).usageChargeMicros).toBe(4n);
    const half = { ...plan, includedUsageUsd: "0", usageMultiplier: "0.5" };
    expect(monthlyCharges(half, 1n).usageChargeMicros).toBe(1n);
    expect(monthlyCharges(half, 2n).usageChargeMicros).toBe(1n);
  });

  it("charges usage at cost, or not at all", () => {
    const atCost = { ...plan, includedUsageUsd: "0", usageMultiplier: "1" };
    expect(monthlyCharges(atCost, 123_456_789n).billableUsageMicros).toBe(
      123_456_789n,
    );
    const free = { ...plan, usageMultiplier: "0.0000" };
    expect(monthlyCharges(free, 999_000_000n).billableUsageMicros).toBe(0n);
  });

  it("refuses a negative cost", () => {
    expect(() => monthlyCharges(plan, -1n)).toThrow(RangeError);
  });
});

describe("nextMonth", () => {
  it("rolls over the year", () => {
    expect(nextMonth("2026-11-01")).toBe("2026-12-01");
    expect(nextMonth("2026-12-01")).toBe("2027-01-01");
    expect(nextMonth("2027-09-01")).toBe("2027-10-01");
  });
});
