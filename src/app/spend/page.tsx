import type { Metadata } from "next";
import Link from "next/link";
import { db } from "@/db";
import { listProjects } from "@/db/projects";
import {
  getDailySpend,
  getSpendBreakdown,
  type BreakdownRow,
} from "@/db/spend-series";
import { requireUser } from "@/lib/auth";
import { formatUsd } from "@/lib/cost";
import {
  dailyRange,
  fillDailySeries,
  parseSpendRange,
  SPEND_RANGES,
} from "@/lib/spend-series";
import { logoutAction } from "../login/actions";
import { DailySpendChart } from "./daily-spend-chart";

export const metadata: Metadata = {
  title: "Spend over time · AI API Cost Tracker",
};

export const dynamic = "force-dynamic";

const PROVIDER_NAMES: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
  mistral: "Mistral",
  other: "Other",
};

const tokens = (value: string) => Number(value).toLocaleString("en-US");
const usd = (value: string) => formatUsd(Number(value));
const tableDay = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  weekday: "short",
  month: "short",
  day: "numeric",
});

type SearchParams = Promise<{
  range?: string | string[];
  project?: string | string[];
}>;

export default async function SpendPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const user = await requireUser("/spend");
  const params = await searchParams;
  const range = parseSpendRange(params.range);
  const projects = await listProjects(db);
  // Only accept a project that exists; anything else means all projects.
  const requested = Array.isArray(params.project)
    ? params.project[0]
    : params.project;
  const project = projects.find((p) => p.id === requested);

  const { start, dayKeys } = dailyRange(new Date(), range);
  const filter = { start, projectId: project?.id };
  const [dailyRows, breakdown] = await Promise.all([
    getDailySpend(db, filter),
    getSpendBreakdown(db, filter),
  ]);
  const days = fillDailySeries(dayKeys, dailyRows);
  const total = breakdown.byProvider.reduce(
    (sum, row) => sum + Number(row.costUsd),
    0,
  );
  const scope = project ? project.name : "All projects";
  const hrefFor = (nextRange: number) =>
    `/spend?range=${nextRange}${project ? `&project=${project.id}` : ""}`;

  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col gap-8 px-4 py-12 sm:px-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <Link href="/" className="text-sm text-foreground/60 underline">
            AI API Cost Tracker
          </Link>
          <h1 className="text-3xl font-semibold tracking-tight">
            Spend over time
          </h1>
        </div>
        <nav className="flex flex-wrap items-center gap-4 text-sm">
          <Link href="/overview" className="underline">
            Overview
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
          aria-label="Date range"
          className="flex rounded-md border border-foreground/15 p-0.5 text-sm"
        >
          {SPEND_RANGES.map((option) => (
            <Link
              key={option}
              href={hrefFor(option)}
              aria-current={option === range ? "true" : undefined}
              className={
                "rounded px-3 py-1 " +
                (option === range
                  ? "bg-foreground font-medium text-background"
                  : "text-foreground/70 hover:bg-foreground/5")
              }
            >
              {option} days
            </Link>
          ))}
        </div>
        <form method="get" className="flex items-center gap-2 text-sm">
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
            className="rounded-md border border-foreground/20 px-3 py-1 hover:bg-foreground/5"
          >
            Apply
          </button>
        </form>
      </div>

      <section
        aria-labelledby="daily-spend"
        className="flex flex-col gap-4 rounded-lg border border-foreground/10 p-5"
      >
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h2 id="daily-spend" className="text-lg font-medium">
              Daily spend
            </h2>
            <p className="text-sm text-foreground/60">
              {scope} · last {range} days · UTC days
            </p>
          </div>
          <p className="text-sm text-foreground/70">
            Total{" "}
            <span
              className="text-lg font-semibold text-foreground"
              data-testid="range-total"
            >
              {formatUsd(total)}
            </span>
          </p>
        </div>

        <DailySpendChart
          days={days}
          label={`Daily spend for ${scope}, last ${range} days`}
        />

        <details className="text-sm">
          <summary className="cursor-pointer text-foreground/70">
            Show as table
          </summary>
          <div className="mt-3 max-h-80 overflow-y-auto">
            <table className="w-full text-left">
              <thead className="text-foreground/60">
                <tr>
                  <th scope="col" className="py-1 font-medium">
                    Day (UTC)
                  </th>
                  <th scope="col" className="py-1 text-right font-medium">
                    Spend
                  </th>
                </tr>
              </thead>
              <tbody className="tabular-nums">
                {[...days].reverse().map((day) => (
                  <tr key={day.day} className="border-t border-foreground/10">
                    <td className="py-1">
                      {tableDay.format(new Date(`${day.day}T00:00:00Z`))}
                    </td>
                    <td className="py-1 text-right">{usd(day.costUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </section>

      <BreakdownTable
        id="by-provider"
        title="By provider"
        rows={breakdown.byProvider}
        name={(row) => PROVIDER_NAMES[row.provider] ?? row.provider}
      />
      <BreakdownTable
        id="by-model"
        title="By model"
        rows={breakdown.byModel}
        name={(row) => (
          <>
            <span className="font-mono">{row.model}</span>{" "}
            <span className="text-xs text-foreground/60">
              {PROVIDER_NAMES[row.provider] ?? row.provider}
            </span>
          </>
        )}
      />
    </main>
  );
}

function BreakdownTable({
  id,
  title,
  rows,
  name,
}: {
  id: string;
  title: string;
  rows: BreakdownRow[];
  name: (row: BreakdownRow) => React.ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <h2 id={id} className="text-lg font-medium">
        {title}
      </h2>
      {rows.length === 0 ? (
        <p className="rounded-lg border border-dashed border-foreground/20 p-6 text-center text-sm text-foreground/60">
          No usage in this range.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-foreground/10">
          <table className="w-full min-w-[40rem] text-left text-sm">
            <thead className="border-b border-foreground/10 text-foreground/60">
              <tr>
                <th scope="col" className="px-4 py-3 font-medium">
                  {title
                    .replace("By ", "")
                    .replace(/^./, (c) => c.toUpperCase())}
                </th>
                <th scope="col" className="px-4 py-3 text-right font-medium">
                  Spend
                </th>
                <th scope="col" className="px-4 py-3 text-right font-medium">
                  Input tokens
                </th>
                <th scope="col" className="px-4 py-3 text-right font-medium">
                  Cached input
                </th>
                <th scope="col" className="px-4 py-3 text-right font-medium">
                  Output tokens
                </th>
                <th scope="col" className="px-4 py-3 text-right font-medium">
                  Requests
                </th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {rows.map((row) => (
                <tr
                  key={`${row.provider}/${row.model ?? ""}`}
                  className="border-b border-foreground/10 last:border-0"
                >
                  <td className="px-4 py-3">{name(row)}</td>
                  <td className="px-4 py-3 text-right font-medium">
                    {usd(row.costUsd)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {tokens(row.inputTokens)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {tokens(row.cachedInputTokens)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {tokens(row.outputTokens)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {row.events.toLocaleString("en-US")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
