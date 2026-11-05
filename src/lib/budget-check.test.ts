import { describe, expect, it } from "vitest";
import {
  checkCap,
  decideBudgetCheck,
  microsToDecimal,
  parseBudgetCheckPayload,
  type BudgetCheckInputs,
} from "./budget-check";

const NOW = new Date("2026-11-05T09:30:00Z");

describe("parseBudgetCheckPayload", () => {
  it("accepts an empty body: no estimate, no run", () => {
    expect(parseBudgetCheckPayload({})).toEqual({
      ok: true,
      request: { estimateMicros: 0n },
    });
  });

  it.each([
    ["0.25", 250_000n],
    [" 1.000001 ", 1_000_001n],
    ["0", 0n],
    [0.25, 250_000n],
    [3, 3_000_000n],
    ["1000000000", 1_000_000_000_000_000n],
  ])("reads the estimate %j exactly", (estimatedCostUsd, micros) => {
    const result = parseBudgetCheckPayload({ estimatedCostUsd });
    expect(result.ok && result.request.estimateMicros).toBe(micros);
  });

  it("trims the run ID", () => {
    const result = parseBudgetCheckPayload({ runId: " run_42 " });
    expect(result.ok && result.request.runId).toBe("run_42");
  });

  it.each([
    { estimatedCostUsd: "-1" },
    { estimatedCostUsd: -0.5 },
    { estimatedCostUsd: "0.0000001" },
    { estimatedCostUsd: 1e-7 },
    { estimatedCostUsd: "1e3" },
    { estimatedCostUsd: "$1" },
    { estimatedCostUsd: "1000000000.000001" },
    { estimatedCostUsd: null },
    { runId: "" },
    { runId: "r".repeat(201) },
    { runId: 42 },
    { estimate: "1" },
  ])("rejects %j", (body) => {
    expect(parseBudgetCheckPayload(body).ok).toBe(false);
  });
});

describe("microsToDecimal", () => {
  it.each([
    [0n, "0.000000"],
    [1n, "0.000001"],
    [12_345_678n, "12.345678"],
    [-1_250_000n, "-1.250000"],
    [-1n, "-0.000001"],
  ])("formats %s", (micros, text) => {
    expect(microsToDecimal(micros)).toBe(text);
  });
});

describe("checkCap", () => {
  it("never denies without a cap", () => {
    expect(checkCap(5_000_000n, null, 9_000_000n)).toEqual({
      capUsd: null,
      spentUsd: "5.000000",
      remainingUsd: null,
      allowed: true,
    });
  });

  it("allows an estimate that uses up exactly what's left", () => {
    expect(checkCap(9_000_000n, 10_000_000n, 1_000_000n)).toMatchObject({
      remainingUsd: "1.000000",
      allowed: true,
    });
    expect(checkCap(9_000_000n, 10_000_000n, 1_000_001n).allowed).toBe(false);
  });

  it("denies even a zero estimate once nothing is left", () => {
    expect(checkCap(10_000_000n, 10_000_000n, 0n)).toMatchObject({
      remainingUsd: "0.000000",
      allowed: false,
    });
    expect(checkCap(12_500_000n, 10_000_000n, 0n)).toMatchObject({
      remainingUsd: "-2.500000",
      allowed: false,
    });
    // A zero cap allows nothing.
    expect(checkCap(0n, 0n, 0n).allowed).toBe(false);
  });

  it("compares exactly, to the micro-dollar", () => {
    expect(checkCap(9_999_999n, 10_000_000n, 1n).allowed).toBe(true);
    expect(checkCap(9_999_999n, 10_000_000n, 2n).allowed).toBe(false);
  });
});

describe("decideBudgetCheck", () => {
  const inputs = (overrides: Partial<BudgetCheckInputs> = {}) => ({
    monthlyBudgetUsd: "100.00",
    runBudgetUsd: "2.00",
    monthSpentUsd: "40.000000",
    runSpentUsd: null,
    ...overrides,
  });

  it("allows within both caps and reports them", () => {
    expect(
      decideBudgetCheck(
        { estimateMicros: 500_000n, runId: "run_42" },
        inputs({ runSpentUsd: "1.250000" }),
        NOW,
      ),
    ).toEqual({
      allowed: true,
      reasons: [],
      estimatedCostUsd: "0.500000",
      month: {
        period: "2026-11",
        capUsd: "100.000000",
        spentUsd: "40.000000",
        remainingUsd: "60.000000",
        allowed: true,
      },
      run: {
        runId: "run_42",
        capUsd: "2.000000",
        spentUsd: "1.250000",
        remainingUsd: "0.750000",
        allowed: true,
      },
    });
  });

  it("denies for the run, the month, or both", () => {
    const run = decideBudgetCheck(
      { estimateMicros: 1_000_000n, runId: "r" },
      inputs({ runSpentUsd: "1.500000" }),
      NOW,
    );
    expect([run.allowed, run.reasons]).toEqual([false, ["run_budget"]]);

    const month = decideBudgetCheck(
      { estimateMicros: 0n },
      inputs({ monthSpentUsd: "100.000000" }),
      NOW,
    );
    expect([month.allowed, month.reasons, month.run]).toEqual([
      false,
      ["monthly_budget"],
      null,
    ]);

    const both = decideBudgetCheck(
      { estimateMicros: 70_000_000n, runId: "r" },
      inputs({ runSpentUsd: "0" }),
      NOW,
    );
    expect(both.reasons).toEqual(["monthly_budget", "run_budget"]);
  });

  it("has no limits without budgets, but still reports spend", () => {
    const result = decideBudgetCheck(
      { estimateMicros: 999_000_000n, runId: "r" },
      inputs({
        monthlyBudgetUsd: null,
        runBudgetUsd: null,
        runSpentUsd: "7.000000",
      }),
      NOW,
    );
    expect(result.allowed).toBe(true);
    expect(result.month).toMatchObject({ capUsd: null, spentUsd: "40.000000" });
    expect(result.run).toMatchObject({ capUsd: null, spentUsd: "7.000000" });
  });
});
