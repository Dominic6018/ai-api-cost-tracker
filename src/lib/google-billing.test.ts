import { describe, expect, it } from "vitest";
import { parseGoogleBilling } from "./google-billing";

const row = {
  day: "2026-11-01",
  currency: "USD",
  cost: "1.25",
  credits: "-0.25",
};
const parsed = {
  day: "2026-11-01",
  micros: 1_250_000n,
  creditsMicros: -250_000n,
};

describe("parseGoogleBilling", () => {
  it("reads the array bq writes, with numbers as strings", () => {
    expect(parseGoogleBilling(JSON.stringify([row]))).toEqual([parsed]);
  });

  it("reads the console's one object per line", () => {
    const second = { ...row, day: "2026-11-02" };
    expect(
      parseGoogleBilling(
        `${JSON.stringify(row)}\r\n${JSON.stringify(second)}\n`,
      ),
    ).toEqual([parsed, { ...parsed, day: "2026-11-02" }]);
  });

  it("accepts plain numbers and rounds float noise to micro-dollars", () => {
    expect(
      parseGoogleBilling(
        JSON.stringify([{ ...row, cost: 0.30000000000000004, credits: 0 }]),
      ),
    ).toEqual([{ day: "2026-11-01", micros: 300_000n, creditsMicros: 0n }]);
  });

  it("treats missing credits as none", () => {
    expect(
      parseGoogleBilling(JSON.stringify([{ ...row, credits: undefined }])),
    ).toEqual([{ ...parsed, creditsMicros: 0n }]);
  });

  it("is empty for an empty result", () => {
    expect(parseGoogleBilling("")).toEqual([]);
    expect(parseGoogleBilling("[]")).toEqual([]);
  });

  it.each([
    [{ ...row, day: "Nov 1" }, /Row 1: day/],
    [{ ...row, currency: "EUR" }, /Row 1: currency must be USD/],
    [{ ...row, cost: "" }, /Row 1: cost/],
    [{ ...row, cost: "a lot" }, /Row 1: cost/],
    [{ ...row, credits: "some" }, /Row 1: credits/],
  ])("rejects %j", (bad, message) => {
    expect(() => parseGoogleBilling(JSON.stringify([bad]))).toThrow(message);
  });

  it("rejects text that isn't JSON", () => {
    expect(() => parseGoogleBilling("day,cost\n2026-11-01,1")).toThrow();
  });
});
