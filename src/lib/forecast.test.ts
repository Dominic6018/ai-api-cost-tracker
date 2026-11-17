import { describe, expect, it } from "vitest";
import {
  forecastWithRange,
  historyDays,
  forecastMonth,
  forecastOverBudget,
  forecastPaceWindow,
  monthEnd,
} from "./forecast";

describe("forecastPaceWindow", () => {
  it("covers the last 7 full UTC days, leaving out today", () => {
    const { start, end } = forecastPaceWindow(new Date("2026-11-05T09:30:00Z"));
    expect(start.toISOString()).toBe("2026-10-29T00:00:00.000Z");
    expect(end.toISOString()).toBe("2026-11-05T00:00:00.000Z");
  });

  it("uses the UTC day, whatever the local time zone says", () => {
    // 00:30 on Nov 5 in UTC+2 is still Nov 4 in UTC.
    const { end } = forecastPaceWindow(new Date("2026-11-05T00:30:00+02:00"));
    expect(end.toISOString()).toBe("2026-11-04T00:00:00.000Z");
  });
});

describe("monthEnd", () => {
  it.each([
    ["2026-11-05T09:30:00Z", "2026-12-01T00:00:00.000Z"],
    ["2026-12-31T23:59:59Z", "2027-01-01T00:00:00.000Z"],
    ["2028-02-10T00:00:00Z", "2028-03-01T00:00:00.000Z"],
  ])("ends %s's month at %s", (now, end) => {
    expect(monthEnd(new Date(now)).toISOString()).toBe(end);
  });
});

describe("forecastMonth", () => {
  it("adds the 7-day pace for the time left in the month", () => {
    // Nov 24 00:00 UTC: exactly 7 days left. $14 over 7 days is $2 a day.
    const forecast = forecastMonth(
      "50.000000",
      "14.000000",
      new Date("2026-11-24T00:00:00Z"),
    );
    expect(forecast.projectedUsd).toBe("64.000000");
    expect(forecast.lastDay.toISOString()).toBe("2026-11-30T00:00:00.000Z");
  });

  it("counts partial days to the millisecond, rounding down", () => {
    // 12 hours left at $1 a day is $0.50.
    expect(
      forecastMonth("1.000000", "7.000000", new Date("2026-11-30T12:00:00Z"))
        .projectedUsd,
    ).toBe("1.500000");
    // 1 ms left at $7 a week: 7,000,000 × 1 / 604,800,000 rounds down to 0.
    expect(
      forecastMonth(
        "1.000000",
        "7.000000",
        new Date("2026-11-30T23:59:59.999Z"),
      ).projectedUsd,
    ).toBe("1.000000");
  });

  it("is the month so far without recent spend", () => {
    expect(
      forecastMonth("3.250001", "0", new Date("2026-11-02T08:00:00Z"))
        .projectedUsd,
    ).toBe("3.250001");
  });

  it("projects a whole month from the first moment of it", () => {
    // 30 days of November at $1 a day.
    expect(
      forecastMonth("0", "7.000000", new Date("2026-11-01T00:00:00Z"))
        .projectedUsd,
    ).toBe("30.000000");
  });
});

describe("forecastOverBudget", () => {
  it("flags a forecast that reaches the budget before spend does", () => {
    expect(forecastOverBudget("60.000000", "100.000000", "100.00")).toBe(true);
    expect(forecastOverBudget("60.000000", "99.999999", "100.00")).toBe(false);
  });

  it("doesn't flag projects already over, or without a budget", () => {
    expect(forecastOverBudget("100.000000", "150.000000", "100.00")).toBe(
      false,
    );
    expect(forecastOverBudget("1.000000", "999.000000", null)).toBe(false);
  });

  it("follows the dashboard's rule for zero budgets", () => {
    // Nothing spent and nothing forecast: a zero budget isn't over.
    expect(forecastOverBudget("0.000000", "0.000000", "0.00")).toBe(false);
    // Spend is forecast against a zero budget.
    expect(forecastOverBudget("0.000000", "0.000001", "0.00")).toBe(true);
  });
});

describe("forecastWithRange", () => {
  // 2026-11-24 12:00 UTC: 6.5 days left in November.
  const now = new Date("2026-11-24T12:00:00Z");
  const paceDaysUsd = ["1", "2", "3", "2", "2", "2", "2"].map(
    (d) => `${d}.000000`,
  );
  const input = {
    monthSpentUsd: "50.000000",
    paceUsd: "14.000000",
    paceDaysUsd,
    earliestUsageAt: new Date("2026-10-01T00:00:00Z"),
  };

  it("projects at the average pace, with the quietest and busiest days as the range", () => {
    expect(forecastWithRange(input, now)).toEqual({
      enough: true,
      // $50 + 6.5 days x $2.
      projectedUsd: "63.000000",
      // x $1 and x $3.
      lowUsd: "56.500000",
      highUsd: "69.500000",
      lastDay: new Date("2026-11-30T00:00:00Z"),
      daysLeft: 6.5,
    });
  });

  it("says there isn't enough data with fewer than 7 full days of history", () => {
    for (const [earliest, days] of [
      ["2026-11-24T00:30:00Z", 0], // today only
      ["2026-11-23T23:59:59Z", 1],
      ["2026-11-18T00:00:00Z", 6],
    ] as const) {
      expect(
        forecastWithRange(
          { ...input, earliestUsageAt: new Date(earliest) },
          now,
        ),
      ).toEqual({
        enough: false,
        historyDays: days,
        lastDay: new Date("2026-11-30T00:00:00Z"),
      });
    }
    expect(
      forecastWithRange({ ...input, earliestUsageAt: null }, now),
    ).toMatchObject({ enough: false, historyDays: 0 });
    // Exactly the start of the pace window is a full week.
    expect(
      forecastWithRange(
        { ...input, earliestUsageAt: new Date("2026-11-17T23:00:00Z") },
        now,
      ).enough,
    ).toBe(true);
  });

  it("projects spend so far when the last week was quiet", () => {
    const quiet = forecastWithRange(
      {
        ...input,
        paceUsd: "0.000000",
        paceDaysUsd: Array(7).fill("0.000000"),
      },
      now,
    );
    expect(quiet).toMatchObject({
      enough: true,
      projectedUsd: "50.000000",
      lowUsd: "50.000000",
      highUsd: "50.000000",
    });
  });
});

describe("historyDays", () => {
  it("counts full UTC days before today, up to a week", () => {
    const now = new Date("2026-11-24T12:00:00Z");
    expect(historyDays(new Date("2026-11-21T09:00:00Z"), now)).toBe(3);
    expect(historyDays(new Date("2020-01-01T00:00:00Z"), now)).toBe(7);
    expect(historyDays(null, now)).toBe(0);
  });
});
