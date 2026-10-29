import { describe, expect, it } from "vitest";
import {
  dailyRange,
  fillDailySeries,
  niceTicks,
  parseSpendRange,
} from "./spend-series";

describe("parseSpendRange", () => {
  it.each([
    ["7", 7],
    ["30", 30],
    ["90", 90],
    [["90", "7"], 90],
  ])("accepts %j", (value, expected) => {
    expect(parseSpendRange(value)).toBe(expected);
  });

  it.each([undefined, "", "14", "-7", "abc", "7.5", "1e1"])(
    "falls back to 30 for %j",
    (value) => {
      expect(parseSpendRange(value)).toBe(30);
    },
  );
});

describe("dailyRange", () => {
  it("covers today and the days before it, from midnight UTC", () => {
    const { start, dayKeys } = dailyRange(new Date("2026-10-29T16:00:00Z"), 7);
    expect(start.toISOString()).toBe("2026-10-23T00:00:00.000Z");
    expect(dayKeys).toEqual([
      "2026-10-23",
      "2026-10-24",
      "2026-10-25",
      "2026-10-26",
      "2026-10-27",
      "2026-10-28",
      "2026-10-29",
    ]);
  });

  it("uses the UTC date, not the local one", () => {
    // Still Oct 31 in UTC, though it's Nov 1 in UTC+2.
    const { dayKeys } = dailyRange(new Date("2026-11-01T01:00:00+02:00"), 1);
    expect(dayKeys).toEqual(["2026-10-31"]);
  });

  it("crosses month and leap-day boundaries", () => {
    const { dayKeys } = dailyRange(new Date("2028-03-01T00:00:00Z"), 3);
    expect(dayKeys).toEqual(["2028-02-28", "2028-02-29", "2028-03-01"]);
  });

  it("returns 90 consecutive days for the longest range", () => {
    const { dayKeys } = dailyRange(new Date("2026-10-29T12:00:00Z"), 90);
    expect(dayKeys).toHaveLength(90);
    expect(dayKeys[0]).toBe("2026-08-01");
    expect(dayKeys.at(-1)).toBe("2026-10-29");
  });
});

describe("fillDailySeries", () => {
  it("fills days without usage with zero and keeps order", () => {
    expect(
      fillDailySeries(
        ["2026-10-27", "2026-10-28", "2026-10-29"],
        [
          { day: "2026-10-29", costUsd: "1.500000" },
          { day: "2026-10-27", costUsd: "0.250000" },
        ],
      ),
    ).toEqual([
      { day: "2026-10-27", costUsd: "0.250000" },
      { day: "2026-10-28", costUsd: "0.000000" },
      { day: "2026-10-29", costUsd: "1.500000" },
    ]);
  });

  it("ignores rows outside the range", () => {
    expect(
      fillDailySeries(["2026-10-29"], [{ day: "2026-01-01", costUsd: "9" }]),
    ).toEqual([{ day: "2026-10-29", costUsd: "0.000000" }]);
  });
});

describe("niceTicks", () => {
  it.each([
    [10, [0, 5, 10]],
    [12, [0, 5, 10, 15]],
    [3.2, [0, 1, 2, 3, 4]],
    [0.006, [0, 0.002, 0.004, 0.006]],
    [0.3, [0, 0.1, 0.2, 0.3]],
    [87, [0, 50, 100]],
    [70, [0, 20, 40, 60, 80]],
    [1, [0, 0.5, 1]],
  ])("covers %d with clean steps", (max, expected) => {
    expect(niceTicks(max)).toEqual(expected);
  });

  it("returns a single zero tick when there's no spend", () => {
    expect(niceTicks(0)).toEqual([0]);
  });

  it("always reaches at least the maximum", () => {
    for (const max of [0.0001, 0.07, 1.3, 42, 999, 12345]) {
      const ticks = niceTicks(max);
      expect(ticks.at(-1)).toBeGreaterThanOrEqual(max);
      expect(ticks.length).toBeLessThanOrEqual(6);
    }
  });
});
