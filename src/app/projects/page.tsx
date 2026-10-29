import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/db";
import { listProjects } from "@/db/projects";
import { formatUsd } from "@/lib/cost";
import { isDashboardEnabled } from "@/lib/dashboard";

export const metadata: Metadata = { title: "Projects · AI API Cost Tracker" };

// Reads the database on every request; never prerender at build time.
export const dynamic = "force-dynamic";

export default async function ProjectsPage() {
  if (!isDashboardEnabled()) notFound();
  const projects = await listProjects(db);

  return (
    <main className="mx-auto flex min-h-screen max-w-4xl flex-col gap-8 px-4 py-12 sm:px-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <Link href="/" className="text-sm text-foreground/60 underline">
            AI API Cost Tracker
          </Link>
          <h1 className="text-3xl font-semibold tracking-tight">Projects</h1>
        </div>
        <Link
          href="/projects/new"
          className="rounded-md bg-foreground px-4 py-2 font-medium text-background"
        >
          New project
        </Link>
      </header>

      {projects.length === 0 ? (
        <p className="rounded-lg border border-dashed border-foreground/20 p-8 text-center text-foreground/70">
          No projects yet. Create one to start recording usage.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-foreground/10">
          <table className="w-full min-w-[32rem] text-left text-sm">
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
                  <td className="px-4 py-3 text-right">
                    <Link
                      href={`/projects/${project.id}/edit`}
                      className="underline"
                      aria-label={`Edit ${project.name}`}
                    >
                      Edit
                    </Link>
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
