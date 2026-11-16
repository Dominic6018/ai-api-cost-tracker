import { describe, expect, it } from "vitest";
import { formatShare, revenueReport, type RevenueInput } from "./revenue";

const input = (
  customerId: string | null,
  revenueMicros: bigint,
  costMicros: bigint,
  unpriced = 0,
): RevenueInput => ({
  customerId,
  name: customerId === null ? null : `Name of ${customerId}`,
  revenueMicros,
  costMicros,
  unpriced,
});

describe("revenueReport", () => {
  it("subtracts AI API cost from revenue, exactly", () => {
    const { rows, total } = revenueReport([
      input("cus_a", 66_000_000n, 30_000_000n),
    ]);
    expect(rows[0]).toMatchObject({
      differenceMicros: 36_000_000n,
      // 36 / 66 = 54.545...%, rounded toward zero.
      sharePermille: 545,
    });
    expect(total).toEqual({
      revenueMicros: 66_000_000n,
      costMicros: 30_000_000n,
      unpriced: 0,
      differenceMicros: 36_000_000n,
      sharePermille: 545,
    });
  });

  it("shows customers who cost more than they brought in", () => {
    const [row] = revenueReport([
      input("cus_a", 10_000_000n, 25_000_000n),
    ]).rows;
    expect(row.differenceMicros).toBe(-15_000_000n);
    // -150%: rounded toward zero, not down.
    expect(row.sharePermille).toBe(-1500);
  });

  it("has no share without revenue", () => {
    const [row] = revenueReport([input("cus_free", 0n, 4_000_000n)]).rows;
    expect(row).toMatchObject({
      differenceMicros: -4_000_000n,
      sharePermille: null,
    });
    // A refund month: negative revenue has no meaningful share either.
    expect(
      revenueReport([input("cus_r", -5_000_000n, 0n)]).rows[0].sharePermille,
    ).toBeNull();
  });

  it("orders by revenue, then cost, with unattributed usage last", () => {
    const { rows, total } = revenueReport([
      input(null, 0n, 9_000_000n, 2),
      input("cus_b", 5_000_000n, 1n),
      input("cus_c", 0n, 3_000_000n, 1),
      input("cus_a", 50_000_000n, 0n),
      input("cus_d", 0n, 7_000_000n),
    ]);
    expect(rows.map((r) => r.customerId)).toEqual([
      "cus_a",
      "cus_b",
      "cus_d",
      "cus_c",
      null,
    ]);
    expect(total).toMatchObject({
      revenueMicros: 55_000_000n,
      costMicros: 19_000_001n,
      unpriced: 3,
    });
  });

  it("is empty for an empty month", () => {
    expect(revenueReport([])).toEqual({
      rows: [],
      total: {
        revenueMicros: 0n,
        costMicros: 0n,
        unpriced: 0,
        differenceMicros: 0n,
        sharePermille: null,
      },
    });
  });
});

describe("formatShare", () => {
  it("shows tenths of a percent", () => {
    expect(formatShare(545)).toBe("54.5%");
    expect(formatShare(-1500)).toBe("-150.0%");
    expect(formatShare(-5)).toBe("-0.5%");
    expect(formatShare(0)).toBe("0.0%");
    expect(formatShare(null)).toBe("—");
  });
});
