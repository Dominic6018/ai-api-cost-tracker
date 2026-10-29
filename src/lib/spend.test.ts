import { describe, expect, it } from "vitest";
import { earliestWindowStart, spendWindows } from "./spend";

const iso = (windows: ReturnType<typeof spendWindows>) => ({
  today: windows.today.toISOString(),
  month: windows.month.toISOString(),
  last30Days: windows.last30Days.toISOString(),
});

describe("spendWindows", () => {
  it("starts today and the month at midnight UTC", () => {
    expect(iso(spendWindows(new Date("2026-10-29T16:20:00Z")))).toEqual({
      today: "2026-10-29T00:00:00.000Z",
      month: "2026-10-01T00:00:00.000Z",
      last30Days: "2026-09-29T16:20:00.000Z",
    });
  });

  it("uses UTC even when the local date would differ", () => {
    // 23:30 UTC on Oct 31 is already Nov 1 in UTC+1.
    expect(iso(spendWindows(new Date("2026-10-31T23:30:00-00:00")))).toEqual({
      today: "2026-10-31T00:00:00.000Z",
      month: "2026-10-01T00:00:00.000Z",
      last30Days: "2026-10-01T23:30:00.000Z",
    });
    // 00:30 in UTC+2 on Nov 1 is still Oct 31 in UTC.
    expect(spendWindows(new Date("2026-11-01T00:30:00+02:00")).month).toEqual(
      new Date("2026-10-01T00:00:00Z"),
    );
  });

  it("handles the first moment of a month and a year", () => {
    expect(iso(spendWindows(new Date("2027-01-01T00:00:00Z")))).toEqual({
      today: "2027-01-01T00:00:00.000Z",
      month: "2027-01-01T00:00:00.000Z",
      last30Days: "2026-12-02T00:00:00.000Z",
    });
  });

  it("handles leap days", () => {
    expect(spendWindows(new Date("2028-02-29T12:00:00Z")).today).toEqual(
      new Date("2028-02-29T00:00:00Z"),
    );
  });
});

describe("earliestWindowStart", () => {
  it("is the month start late in a month", () => {
    const windows = spendWindows(new Date("2026-10-31T12:00:00Z"));
    expect(earliestWindowStart(windows)).toEqual(
      new Date("2026-10-01T00:00:00Z"),
    );
  });

  it("is the 30-day start early in a month", () => {
    const windows = spendWindows(new Date("2026-10-02T12:00:00Z"));
    expect(earliestWindowStart(windows)).toEqual(
      new Date("2026-09-02T12:00:00Z"),
    );
  });
});
