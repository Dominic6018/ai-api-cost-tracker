import {
  budgetUtilization,
  formatMicrosUsd,
  formatUsedPercent,
} from "@/lib/budget";
import { formatUsd } from "@/lib/cost";

/**
 * This month's spend against a project's monthly budget: amounts, the
 * share used, and a meter. Projects without a budget show spend only.
 * Threshold colours for nearing or exceeding a budget come with #12.
 */
export function BudgetMeter({
  spentUsd,
  budgetUsd,
}: {
  spentUsd: string;
  budgetUsd: string | null;
}) {
  const utilization = budgetUtilization(spentUsd, budgetUsd);
  const spent = formatMicrosUsd(utilization.spentMicros, formatUsd);

  if (!utilization.hasBudget) {
    return (
      <div data-testid="budget" className="flex flex-col gap-1">
        <span className="tabular-nums">{spent}</span>
        <span className="text-xs text-foreground/60">No budget</span>
      </div>
    );
  }

  const budget = formatMicrosUsd(utilization.budgetMicros, formatUsd);
  const percent = formatUsedPercent(utilization);
  const remaining = formatMicrosUsd(
    utilization.overBudget
      ? -utilization.remainingMicros
      : utilization.remainingMicros,
    formatUsd,
  );
  // The bar stops at 100%; the text carries the exact figure.
  const fill =
    utilization.usedPermille === null
      ? 100
      : Math.min(100, utilization.usedPermille / 10);

  return (
    <div data-testid="budget" className="viz flex min-w-44 flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="tabular-nums">
          {spent} <span className="text-foreground/60">of {budget}</span>
        </span>
        <span className="font-medium tabular-nums">{percent}</span>
      </div>
      <div
        role="meter"
        aria-label="Monthly budget used"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={fill}
        aria-valuetext={`${percent} of ${budget} used`}
        className="h-1.5 overflow-hidden rounded-full"
        style={{ background: "var(--viz-meter-track)" }}
      >
        <div
          className="h-full rounded-full"
          style={{ width: `${fill}%`, background: "var(--viz-series-1)" }}
        />
      </div>
      <span className="text-xs text-foreground/60 tabular-nums">
        {utilization.overBudget ? `Over by ${remaining}` : `${remaining} left`}
      </span>
    </div>
  );
}
