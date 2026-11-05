import { describe, expect, it } from "vitest";
import { detectSpike } from "./spike";

describe("detectSpike", () => {
  it("flags a day at exactly 3× the usual daily spend", () => {
    // $14 over 7 days is $2 a day; 3× is $6.
    expect(detectSpike("6.000000", "14.000000")).toEqual({
      spike: true,
      dailyAverageUsd: "2.000000",
      multiple: 3,
    });
  });

  it("doesn't flag a day a micro-dollar under 3×", () => {
    expect(detectSpike("5.999999", "14.000000")).toMatchObject({
      spike: false,
      multiple: 2.9,
    });
  });

  it("rounds the multiple down to one decimal", () => {
    // $10.40 against $2 a day is 5.2×; $10.39 is 5.195×, shown as 5.1.
    expect(detectSpike("10.400000", "14.000000").multiple).toBe(5.2);
    expect(detectSpike("10.390000", "14.000000").multiple).toBe(5.1);
  });

  it("needs at least $1, however quiet the week was", () => {
    expect(detectSpike("0.999999", "0.070000").spike).toBe(false);
    expect(detectSpike("1.000000", "0.070000")).toMatchObject({
      spike: true,
      multiple: 100,
    });
  });

  it("flags $1 or more after a week without spend, with no multiple", () => {
    expect(detectSpike("1.000000", "0")).toEqual({
      spike: true,
      dailyAverageUsd: "0.000000",
      multiple: null,
    });
    expect(detectSpike("0", "0")).toMatchObject({
      spike: false,
      multiple: null,
    });
  });

  it("compares exactly where the average isn't a whole micro-dollar", () => {
    // $10 over 7 days: 3× the daily average is $4.285714285…, so
    // $4.285714 is just under and $4.285715 just over.
    expect(detectSpike("4.285714", "10.000000").spike).toBe(false);
    expect(detectSpike("4.285715", "10.000000").spike).toBe(true);
  });
});
