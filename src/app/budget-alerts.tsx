import Link from "next/link";
import type { ProjectSpend } from "@/db/spend";
import { budgetAlerts, formatMicrosUsd, formatUsedPercent } from "@/lib/budget";
import { formatUsd } from "@/lib/cost";
import { budgetStatusLabel, BudgetStatusIcon } from "./budget-status";

/**
 * Summary of projects nearing or over their monthly budget. Renders
 * nothing when every project is within budget.
 */
export function BudgetAlerts({ projects }: { projects: ProjectSpend[] }) {
  const alerts = budgetAlerts(projects);
  if (alerts.length === 0) return null;
  const over = alerts.filter((a) => a.status === "over").length;

  return (
    <section
      role="status"
      aria-labelledby="budget-alerts"
      data-testid="budget-alerts"
      className="flex flex-col gap-3 rounded-lg border border-foreground/15 p-5"
    >
      <h2 id="budget-alerts" className="flex items-center gap-2 font-medium">
        <BudgetStatusIcon status={over > 0 ? "over" : "warning"} />
        {alerts.length === 1
          ? "1 project needs attention"
          : `${alerts.length} projects need attention`}
      </h2>
      <ul className="flex flex-col gap-2 text-sm">
        {alerts.map(({ project, utilization, status }) => (
          <li
            key={project.id}
            data-budget-status={status}
            className="flex flex-wrap items-center gap-x-3 gap-y-1"
          >
            <span className="inline-flex items-center gap-1.5 font-medium">
              <BudgetStatusIcon status={status} />
              {budgetStatusLabel(
                status,
                !utilization.hasBudget || utilization.overBudget,
              )}
            </span>
            <Link href="/projects" className="underline">
              {project.name}
            </Link>
            {utilization.hasBudget && (
              <span className="text-foreground/70 tabular-nums">
                {formatMicrosUsd(utilization.spentMicros, formatUsd)} of{" "}
                {formatMicrosUsd(utilization.budgetMicros, formatUsd)}
                {utilization.usedPermille !== null &&
                  ` (${formatUsedPercent(utilization)})`}
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
