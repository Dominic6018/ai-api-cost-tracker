/** Micro-dollars (USD × 1,000,000), the precision of `cost_usd`. */
const MICROS_PER_USD = 1_000_000n;

/**
 * Parses a non-negative decimal string such as "12.5" or "0.000001" into
 * micro-dollars. Exact integer arithmetic keeps a spend of $99.999999
 * from being rounded up to 100% of a $100 budget.
 */
export function toMicros(usd: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,6})\d*)?$/.exec(usd.trim());
  if (!match) throw new TypeError(`Not a USD amount: "${usd}"`);
  const [, whole, fraction = ""] = match;
  return BigInt(whole) * MICROS_PER_USD + BigInt(fraction.padEnd(6, "0"));
}

export function microsToUsd(micros: bigint): number {
  return Number(micros) / Number(MICROS_PER_USD);
}

export type BudgetUtilization =
  | { hasBudget: false; spentMicros: bigint }
  | {
      hasBudget: true;
      spentMicros: bigint;
      budgetMicros: bigint;
      /** Positive when under budget, negative when over. */
      remainingMicros: bigint;
      /**
       * Share of the budget used, in tenths of a percent, rounded down
       * (1000 = 100.0%). Null when the budget is zero and there is spend,
       * where a percentage is meaningless.
       */
      usedPermille: number | null;
      overBudget: boolean;
    };

/** Current spend against a monthly budget (null for no budget). */
export function budgetUtilization(
  spentUsd: string,
  budgetUsd: string | null,
): BudgetUtilization {
  const spentMicros = toMicros(spentUsd);
  if (budgetUsd === null) return { hasBudget: false, spentMicros };

  const budgetMicros = toMicros(budgetUsd);
  let usedPermille: number | null;
  if (budgetMicros === 0n) {
    usedPermille = spentMicros === 0n ? 0 : null;
  } else {
    usedPermille = Number((spentMicros * 1000n) / budgetMicros);
  }
  return {
    hasBudget: true,
    spentMicros,
    budgetMicros,
    remainingMicros: budgetMicros - spentMicros,
    usedPermille,
    overBudget: spentMicros > budgetMicros,
  };
}

/**
 * Formats a non-negative amount, showing "<$0.0001" rather than "$0.00"
 * for a non-zero amount too small to display.
 */
export function formatMicrosUsd(
  micros: bigint,
  format: (usd: number) => string,
): string {
  if (micros > 0n && micros < 100n) return "<$0.0001";
  return format(microsToUsd(micros));
}

/** "3.1%", "<0.1%" for tiny non-zero use, "—" when undefined. */
export function formatUsedPercent(
  utilization: Extract<BudgetUtilization, { hasBudget: true }>,
): string {
  const { usedPermille, spentMicros } = utilization;
  if (usedPermille === null) return "—";
  if (usedPermille === 0 && spentMicros > 0n) return "<0.1%";
  return `${(usedPermille / 10).toFixed(1)}%`;
}

/**
 * Alert thresholds as a percentage of the monthly budget. The single
 * source for every budget warning in the app.
 */
export const BUDGET_THRESHOLDS = {
  warningPercent: 80,
  overPercent: 100,
} as const;

export type BudgetStatus = "none" | "ok" | "warning" | "over";

/**
 * Alert state for a project's month. Compared exactly in micro-dollars,
 * so 79.999999% is "ok" and exactly 80% is "warning". Spending exactly
 * the budget counts as "over": it's at 100%, with nothing left.
 */
export function budgetStatus(utilization: BudgetUtilization): BudgetStatus {
  if (!utilization.hasBudget) return "none";
  const { spentMicros, budgetMicros } = utilization;
  const atPercent = (percent: number) =>
    spentMicros * 100n >= budgetMicros * BigInt(percent);
  if (atPercent(BUDGET_THRESHOLDS.overPercent)) {
    // A zero budget with no spend has nothing to alert about.
    return budgetMicros === 0n && spentMicros === 0n ? "ok" : "over";
  }
  return atPercent(BUDGET_THRESHOLDS.warningPercent) ? "warning" : "ok";
}

/** Projects at or above a budget threshold this month, worst first. */
export function budgetAlerts<
  P extends { name: string; month: string; monthlyBudgetUsd: string | null },
>(projects: P[]) {
  return projects
    .map((project) => {
      const utilization = budgetUtilization(
        project.month,
        project.monthlyBudgetUsd,
      );
      return { project, utilization, status: budgetStatus(utilization) };
    })
    .filter(
      (alert): alert is typeof alert & { status: "warning" | "over" } =>
        alert.status === "warning" || alert.status === "over",
    )
    .sort(
      (a, b) =>
        Number(b.status === "over") - Number(a.status === "over") ||
        a.project.name.localeCompare(b.project.name),
    );
}
