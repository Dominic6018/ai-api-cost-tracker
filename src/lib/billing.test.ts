import { describe, expect, it } from "vitest";
import {
  customerCreatedEntry,
  formatEntryUsd,
  ledgerEntryAudit,
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
