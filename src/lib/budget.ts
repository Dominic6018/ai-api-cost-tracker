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
