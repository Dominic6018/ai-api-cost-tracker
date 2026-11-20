import type { Metadata } from "next";
import Link from "next/link";
import { DashboardNav } from "../dashboard-nav";
import { db } from "@/db";
import { listProjects } from "@/db/projects";
import { organizationScope } from "@/db/scope";
import { getSpendOverview } from "@/db/spend";
import { budgetStatus, budgetUtilization } from "@/lib/budget";
import { formatUsd } from "@/lib/cost";
import { requireUser } from "@/lib/auth";
import { can } from "@/lib/roles";
import { BudgetAlerts } from "../budget-alerts";
import { BudgetStatusBadge } from "../budget-status";

export const metadata: Metadata = { title: "Projects · AI API Cost Tracker" };

// Reads the database on every request; never prerender at build time.
export const dynamic = "force-dynamic";

export default async function ProjectsPage() {
  const user = await requireUser("/projects");
  const canManage = can(user, "projects:manage");
  const canManageKeys = can(user, "api_keys:manage");
  const [projects, overview] = await Promise.all([
    listProjects(db, organizationScope(user)),
    getSpendOverview(db, organizationScope(user)),
  ]);
  const monthSpend = new Map(overview.projects.map((p) => [p.id, p.month]));

  return (
    <main className="mx-auto flex min-h-screen max-w-4xl flex-col gap-8 px-4 py-12 sm:px-8">
      <DashboardNav user={user} current="/projects" />
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-3xl font-semibold tracking-tight">Projects</h1>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {canManage && (
            <Link
              href="/projects/new"
              className="rounded-md bg-foreground px-4 py-2 font-medium text-background"
            >
              New project
            </Link>
          )}
        </div>
      </header>

      <BudgetAlerts projects={overview.projects} />

      {projects.length === 0 ? (
        <p className="rounded-lg border border-dashed border-foreground/20 p-8 text-center text-foreground/70">
          No projects yet. Create one to start recording usage.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-foreground/10">
          <table className="w-full min-w-[40rem] text-left text-sm">
            <thead className="border-b border-foreground/10 text-foreground/60">
              <tr>
                <th scope="col" className="px-4 py-3 font-medium">
                  Name
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  Slug
                </th>
                <th scope="col" className="px-4 py-3 text-right font-medium">
                  Monthly budget
                </th>
                <th scope="col" className="px-4 py-3 text-right font-medium">
                  Spent this month
                </th>
                <th scope="col" className="px-4 py-3">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {projects.map((project) => (
                <tr
                  key={project.id}
                  className="border-b border-foreground/10 last:border-0"
                >
                  <td className="px-4 py-3 font-medium">{project.name}</td>
                  <td className="px-4 py-3 font-mono text-foreground/80">
                    {project.slug}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {project.monthlyBudgetUsd === null ? (
                      <span className="text-foreground/50">No budget</span>
                    ) : (
                      formatUsd(Number(project.monthlyBudgetUsd))
                    )}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {(() => {
                      const spent = monthSpend.get(project.id) ?? "0";
                      const utilization = budgetUtilization(
                        spent,
                        project.monthlyBudgetUsd,
                      );
                      const status = budgetStatus(utilization);
                      return (
                        <div className="flex flex-col items-end gap-1">
                          <span>{formatUsd(Number(spent))}</span>
                          <BudgetStatusBadge
                            status={status}
                            overBudget={
                              !utilization.hasBudget || utilization.overBudget
                            }
                          />
                        </div>
                      );
                    })()}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex justify-end gap-3">
                      {canManageKeys && (
                        <Link
                          href={`/projects/${project.id}/keys`}
                          className="underline"
                          aria-label={`API keys for ${project.name}`}
                        >
                          Keys
                        </Link>
                      )}
                      {canManage && (
                        <Link
                          href={`/projects/${project.id}/edit`}
                          className="underline"
                          aria-label={`Edit ${project.name}`}
                        >
                          Edit
                        </Link>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
