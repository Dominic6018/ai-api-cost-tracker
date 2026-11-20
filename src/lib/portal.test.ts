import { describe, expect, it } from "vitest";
import { BILLING_ENTRY_KINDS } from "@/db/schema";
import {
  describeBalance,
  ENTRY_KIND_LABELS,
  formatStatementUsd,
  portalUrl,
} from "./portal";

describe("formatStatementUsd", () => {
  it.each([
    [0n, "$0.00"],
    [64_000_000n, "$64.00"],
    [12_340_000n, "$12.34"],
    [12_345_678n, "$12.345678"],
    [1_500n, "$0.0015"],
    [-10_000_000n, "-$10.00"],
    [1_234_567_890_000n, "$1,234,567.89"],
  ])("%s micros is %s", (micros, text) => {
    expect(formatStatementUsd(micros)).toBe(text);
  });
});

describe("describeBalance", () => {
  it("says who owes whom, as a positive amount", () => {
    expect(describeBalance(5_000_000n)).toEqual({
      label: "You owe",
      micros: 5_000_000n,
    });
    expect(describeBalance(-5_000_000n)).toEqual({
      label: "In credit",
      micros: 5_000_000n,
    });
    expect(describeBalance(0n)).toEqual({ label: "Nothing owed", micros: 0n });
  });
});

it("names every kind of ledger entry", () => {
  for (const kind of BILLING_ENTRY_KINDS) {
    expect(ENTRY_KIND_LABELS[kind]).toBeTruthy();
  }
});

it("makes a portal link on the request's host", () => {
  expect(
    portalUrl("t".repeat(43), { host: "costs.example.com", proto: null }),
  ).toBe(`https://costs.example.com/portal/${"t".repeat(43)}`);
});
