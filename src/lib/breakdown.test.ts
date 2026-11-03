import { describe, expect, it } from "vitest";
import {
  breakdownRows,
  formatShare,
  parseBreakdownDimension,
} from "./breakdown";

describe("parseBreakdownDimension", () => {
  it.each([
    ["customer", "customerId"],
    ["user", "userId"],
    ["feature", "feature"],
    ["run", "runId"],
    [["run", "feature"], "runId"],
  ])("reads by=%j as %s", (value, key) => {
    expect(parseBreakdownDimension(value).key).toBe(key);
  });

  it.each([undefined, "", "customerId", "project"])(
    "falls back to customer for %j",
    (value) => {
      expect(parseBreakdownDimension(value).key).toBe("customerId");
    },
  );
});

describe("breakdownRows", () => {
  it("computes exact shares and per-request averages", () => {
    const rows = breakdownRows(
      [
        { value: "acme", costUsd: "6.000000", events: 3 },
        { value: null, costUsd: "3.000000", events: 2 },
        { value: "globex", costUsd: "1.000000", events: 3 },
      ],
      { costUsd: "10.000000", events: 8, groups: 3 },
    );
    expect(
      rows.map((r) => [r.kind, r.value, r.sharePermille, r.averageMicros]),
    ).toEqual([
      ["group", "acme", 600, 2_000_000n],
      ["unset", null, 300, 1_500_000n],
      // $1 / 3 = $0.333333 (rounded half up)
      ["group", "globex", 100, 333_333n],
    ]);
  });

  it("rolls groups beyond the top into one Other row, so costs add up", () => {
    const rows = breakdownRows(
      [
        { value: "a", costUsd: "5.000000", events: 5 },
        { value: "b", costUsd: "3.000001", events: 1 },
      ],
      { costUsd: "10.000002", events: 10, groups: 6 },
    );
    expect(rows.at(-1)).toEqual({
      value: null,
      kind: "other",
      costMicros: 2_000_001n,
      events: 4,
      groups: 4,
      sharePermille: 200, // 2.000001 / 10.000002 is just over 20%
      averageMicros: 500_000n,
    });
    expect(rows.reduce((sum, r) => sum + r.costMicros, 0n)).toBe(10_000_002n);
  });

  it("has no Other row when every group is shown, and no rows for no usage", () => {
    expect(
      breakdownRows([{ value: "a", costUsd: "1.000000", events: 1 }], {
        costUsd: "1.000000",
        events: 1,
        groups: 1,
      }).map((r) => r.kind),
    ).toEqual(["group"]);
    expect(
      breakdownRows([], { costUsd: "0.000000", events: 0, groups: 0 }),
    ).toEqual([]);
  });

  it("handles free usage without dividing by zero", () => {
    const [row] = breakdownRows(
      [{ value: "a", costUsd: "0.000000", events: 2 }],
      { costUsd: "0.000000", events: 2, groups: 1 },
    );
    expect([row.sharePermille, row.averageMicros]).toEqual([0, 0n]);
  });
});

describe("formatShare", () => {
  it("shows one decimal, and <0.1% for a tiny non-zero share", () => {
    expect(formatShare(600, 1n)).toBe("60.0%");
    expect(formatShare(1000, 1n)).toBe("100.0%");
    expect(formatShare(0, 5n)).toBe("<0.1%");
    expect(formatShare(0, 0n)).toBe("0.0%");
  });
});
