import type { Metadata } from "next";
import Link from "next/link";
import { db } from "@/db";
import { getSpendByAttribution } from "@/db/attribution-spend";
import { listProjects } from "@/db/projects";
import { ATTRIBUTION_FIELDS } from "@/lib/attribution";
import { requireUser } from "@/lib/auth";
import { microsToUsd } from "@/lib/budget";
import {
  BREAKDOWN_LIMIT,
  breakdownRows,
  formatShare,
  parseBreakdownDimension,
  type BreakdownRow,
} from "@/lib/breakdown";
import { formatUsd } from "@/lib/cost";
import { dailyRange, parseSpendRange, SPEND_RANGES } from "@/lib/spend-series";
import { usageQuery } from "@/lib/usage-filters";
import { logoutAction } from "../login/actions";

export const metadata: Metadata = {
  title: "Cost breakdown · AI API Cost Tracker",
};

export const dynamic = "force-dynamic";

const usd = (micros: bigint) => formatUsd(microsToUsd(micros));
const count = (n: number) => n.toLocaleString("en-US");
const plural = (n: number, word: string) =>
  `${count(n)} ${word}${n === 1 ? "" : "s"}`;

type SearchParams = Promise<{
  by?: string | string[];
  range?: string | string[];
  project?: string | string[];
}>;

export default async function BreakdownPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const user = await requireUser("/breakdown");
  const params = await searchParams;
  const dimension = parseBreakdownDimension(params.by);
  const range = parseSpendRange(params.range);
  const projects = await listProjects(db);
  // Only accept a project that exists; anything else means all projects.
  const requested = Array.isArray(params.project)
    ? params.project[0]
    : params.project;
  const project = projects.find((p) => p.id === requested);

  const { start, dayKeys } = dailyRange(new Date(), range);
  const { top, totals } = await getSpendByAttribution(db, {
    key: dimension.key,
    start,
    projectId: project?.id,
    limit: BREAKDOWN_LIMIT,
  });
  const rows = breakdownRows(top, totals);
  const totalMicros = rows.reduce((sum, row) => sum + row.costMicros, 0n);
  const hasUnset = rows.some((row) => row.kind === "unset");
  const attributedGroups = totals.groups - (hasUnset ? 1 : 0);
  const label = dimension.label.toLowerCase();
  const scope = project ? project.name : "All projects";

  const hrefFor = (change: { by?: string; range?: number }) => {
    const query = new URLSearchParams({
      by: change.by ?? dimension.param,
      range: String(change.range ?? range),
    });
    if (project) query.set("project", project.id);
    return `/breakdown?${query}`;
  };
  // The usage events behind a row, over the same days and project.
  const eventsHref = (row: BreakdownRow) =>
    `/usage${usageQuery({
      projectId: project?.id,
      from: dayKeys[0],
      to: dayKeys.at(-1),
      [dimension.key]: row.value ?? undefined,
    })}`;
  const segment = (active: boolean) =>
    "rounded px-3 py-1 " +
    (active
      ? "bg-foreground font-medium text-background"
      : "text-foreground/70 hover:bg-foreground/5");

  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col gap-8 px-4 py-12 sm:px-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <Link href="/" className="text-sm text-foreground/60 underline">
            AI API Cost Tracker
          </Link>
          <h1 className="text-3xl font-semibold tracking-tight">
            Cost by {label}
          </h1>
        </div>
        <nav className="flex flex-wrap items-center gap-4 text-sm">
          <Link href="/overview" className="underline">
            Overview
          </Link>
          <Link href="/spend" className="underline">
            Spend over time
          </Link>
          <Link href="/usage" className="underline">
            Usage events
          </Link>
          <Link href="/projects" className="underline">
            Projects
          </Link>
          <form action={logoutAction} className="flex items-center gap-3">
            <span className="text-foreground/60">{user.email}</span>
            <button type="submit" className="underline">
              Sign out
            </button>
          </form>
        </nav>
      </header>

      {/* Filters: one row, above everything they scope */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <div
          role="group"
          aria-label="Group by"
          className="flex rounded-md border border-foreground/15 p-0.5 text-sm"
        >
          {ATTRIBUTION_FIELDS.map((field) => (
            <Link
              key={field.key}
              href={hrefFor({ by: field.param })}
              aria-current={field.key === dimension.key ? "true" : undefined}
              className={segment(field.key === dimension.key)}
            >
              {field.label}
            </Link>
          ))}
        </div>
        <div
          role="group"
          aria-label="Date range"
          className="flex rounded-md border border-foreground/15 p-0.5 text-sm"
        >
          {SPEND_RANGES.map((option) => (
            <Link
              key={option}
              href={hrefFor({ range: option })}
              aria-current={option === range ? "true" : undefined}
              className={segment(option === range)}
            >
              {option} days
            </Link>
          ))}
        </div>
        <form method="get" className="flex items-center gap-2 text-sm">
          <input type="hidden" name="by" value={dimension.param} />
          <input type="hidden" name="range" value={range} />
          <label htmlFor="project" className="text-foreground/70">
            Project
          </label>
          <select
            id="project"
            name="project"
            defaultValue={project?.id ?? ""}
            className="rounded-md border border-foreground/20 bg-background px-2 py-1"
          >
            <option value="">All projects</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <button
            type="submit"
            className="rounded-md border border-foreground/20 px-3 py-1"
          >
            Apply
          </button>
        </form>
      </div>

      <p className="text-sm text-foreground/70" data-testid="breakdown-summary">
        {scope} · last {range} days (UTC) · {usd(totalMicros)} across{" "}
        {plural(totals.events, "request")} · {plural(attributedGroups, label)}
      </p>

      {rows.length === 0 ? (
        <p className="rounded-lg border border-dashed border-foreground/20 p-8 text-center text-foreground/70">
          No usage in this range.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-foreground/10">
          <table
            className="w-full min-w-[40rem] text-left text-sm"
            data-testid="cost-breakdown"
          >
            <thead className="border-b border-foreground/10 text-foreground/60">
              <tr>
                <th scope="col" className="px-3 py-3 font-medium">
                  {dimension.label}
                </th>
                {["Cost", "Share", "Requests", "Per request"].map((heading) => (
                  <th
                    key={heading}
                    scope="col"
                    className="px-3 py-3 text-right font-medium"
                  >
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {rows.map((row) => (
                <tr
                  key={row.kind === "group" ? `g:${row.value}` : row.kind}
                  data-kind={row.kind}
                  className="border-b border-foreground/10 last:border-0"
                >
                  <td className="max-w-80 truncate px-3 py-2">
                    {row.kind === "group" && (
                      <Link
                        href={eventsHref(row)}
                        className="font-mono text-xs underline decoration-foreground/30"
                        title={`Show usage events for this ${label}`}
                      >
                        {row.value}
                      </Link>
                    )}
                    {row.kind === "unset" && (
                      <span className="text-foreground/60">Not set</span>
                    )}
                    {row.kind === "other" && (
                      <span className="text-foreground/60">
                        Other ({plural(row.groups, label)})
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right font-medium">
                    {usd(row.costMicros)}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {formatShare(row.sharePermille, row.costMicros)}
                  </td>
                  <td className="px-3 py-2 text-right">{count(row.events)}</td>
                  <td className="px-3 py-2 text-right">
                    {usd(row.averageMicros)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {hasUnset && (
        <p className="text-sm text-foreground/60">
          “Not set” is usage recorded without a {label}. Send{" "}
          <code className="font-mono text-xs">{dimension.key}</code> with usage
          to attribute it.
        </p>
      )}
    </main>
  );
}
