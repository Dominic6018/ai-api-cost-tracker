import { BUDGET_THRESHOLDS, type BudgetStatus } from "@/lib/budget";

type AlertStatus = Extract<BudgetStatus, "warning" | "over">;

export const BUDGET_STATUS_LABELS: Record<AlertStatus, string> = {
  warning: "Nearing budget",
  over: "Over budget",
};

export const BUDGET_STATUS_DESCRIPTIONS: Record<AlertStatus, string> = {
  warning: `At or above ${BUDGET_THRESHOLDS.warningPercent}% of this month's budget`,
  over: `At or above ${BUDGET_THRESHOLDS.overPercent}% of this month's budget`,
};

/**
 * Status icon: a filled shape in the reserved status colour with a
 * high-contrast glyph, so it reads even where the colour alone wouldn't
 * (the warning yellow is below 3:1 on light backgrounds).
 */
export function BudgetStatusIcon({ status }: { status: AlertStatus }) {
  return status === "warning" ? (
    <svg viewBox="0 0 16 16" className="size-4 shrink-0" aria-hidden="true">
      <path d="M8 1.5 15 14.5H1z" fill="var(--status-warning)" />
      <path
        d="M8 6v4"
        stroke="#0b0b0b"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <circle cx="8" cy="12.2" r="0.9" fill="#0b0b0b" />
    </svg>
  ) : (
    <svg viewBox="0 0 16 16" className="size-4 shrink-0" aria-hidden="true">
      <circle cx="8" cy="8" r="7" fill="var(--status-critical)" />
      <path
        d="M8 4.5v4.2"
        stroke="#ffffff"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <circle cx="8" cy="11.3" r="0.9" fill="#ffffff" />
    </svg>
  );
}

/**
 * Label for an alert. Spending exactly the budget is in the over-budget
 * state (100%), but it is worded as used up rather than over.
 */
export function budgetStatusLabel(
  status: AlertStatus,
  overBudget: boolean,
): string {
  return status === "over" && !overBudget
    ? "Budget used up"
    : BUDGET_STATUS_LABELS[status];
}

/** Icon plus label; renders nothing for "ok" and "none". */
export function BudgetStatusBadge({
  status,
  overBudget = true,
}: {
  status: BudgetStatus;
  /** False when spend equals the budget exactly. */
  overBudget?: boolean;
}) {
  if (status !== "warning" && status !== "over") return null;
  return (
    <span
      data-budget-status={status}
      title={BUDGET_STATUS_DESCRIPTIONS[status]}
      className="inline-flex items-center gap-1.5 text-xs font-medium text-foreground"
    >
      <BudgetStatusIcon status={status} />
      {budgetStatusLabel(status, overBudget)}
    </span>
  );
}
