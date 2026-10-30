import {
  budgetStatus,
  budgetUtilization,
  formatMicrosUsd,
  formatUsedPercent,
} from "@/lib/budget";
import { BudgetStatusBadge } from "../budget-status";
import { formatUsd } from "@/lib/cost";

/**
 * This month's spend against a project's monthly budget: amounts, the
 * share used, and a meter. Projects without a budget show spend only.
 * Nearing or exceeding the budget turns the meter to a status colour and
 * adds an icon and label, so the state never relies on colour alone.
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
  const status = budgetStatus(utilization);
  const barColor =
    status === "over"
      ? "var(--status-critical)"
      : status === "warning"
        ? "var(--status-warning)"
        : "var(--viz-series-1)";
  // A status fill sits on a neutral track rather than the blue one.
  const trackColor =
    status === "ok"
      ? "var(--viz-meter-track)"
      : "var(--viz-meter-track-neutral)";
  // The bar stops at 100%; the text carries the exact figure.
  const fill =
    utilization.usedPermille === null
      ? 100
      : Math.min(100, utilization.usedPermille / 10);

  return (
    <div
      data-testid="budget"
      data-budget-state={status}
      className="viz flex min-w-44 flex-col gap-1.5"
    >
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
        style={{ background: trackColor }}
      >
        <div
          className="h-full rounded-full"
          style={{ width: `${fill}%`, background: barColor }}
        />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <span className="text-xs text-foreground/60 tabular-nums">
          {utilization.overBudget
            ? `Over by ${remaining}`
            : `${remaining} left`}
        </span>
        <BudgetStatusBadge
          status={status}
          overBudget={utilization.overBudget}
        />
      </div>
    </div>
  );
}
