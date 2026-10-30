import type { Metadata } from "next";
import Link from "next/link";
import { db } from "@/db";
import { listProjects } from "@/db/projects";
import { providerEnum } from "@/db/schema";
import { listUsageEvents, listUsageModels } from "@/db/usage-events";
import { requireUser } from "@/lib/auth";
import { formatUsd } from "@/lib/cost";
import { parseUsageFilters, usageQuery } from "@/lib/usage-filters";
import { logoutAction } from "../login/actions";

export const metadata: Metadata = {
  title: "Usage events · AI API Cost Tracker",
};

export const dynamic = "force-dynamic";

const PROVIDER_NAMES: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
  mistral: "Mistral",
  other: "Other",
};

const utcTime = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

const count = (n: number) => n.toLocaleString("en-US");
const fieldClass =
  "rounded-md border border-foreground/20 bg-background px-2 py-1 text-sm";

export default async function UsagePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser("/usage");
  const filters = parseUsageFilters(await searchParams);
  const [page, projects, models] = await Promise.all([
    listUsageEvents(db, filters),
    listProjects(db),
    listUsageModels(db),
  ]);
  const { cursor, ...withoutCursor } = filters;
  const isFiltered = Object.keys(withoutCursor).length > 0;

  return (
    <main className="mx-auto flex min-h-screen max-w-6xl flex-col gap-8 px-4 py-12 sm:px-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <Link href="/" className="text-sm text-foreground/60 underline">
            AI API Cost Tracker
          </Link>
          <h1 className="text-3xl font-semibold tracking-tight">
            Usage events
          </h1>
        </div>
        <nav className="flex flex-wrap items-center gap-4 text-sm">
          <Link href="/overview" className="underline">
            Overview
          </Link>
          <Link href="/spend" className="underline">
            Spend over time
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

      {/* Filters: one row, above the table they scope; kept in the URL */}
      <form
        method="get"
        className="flex flex-wrap items-end gap-x-4 gap-y-3 text-sm"
      >
        <label className="flex flex-col gap-1">
          <span className="text-foreground/70">Project</span>
          <select
            name="project"
            defaultValue={filters.projectId ?? ""}
            className={fieldClass}
          >
            <option value="">All projects</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-foreground/70">Provider</span>
          <select
            name="provider"
            defaultValue={filters.provider ?? ""}
            className={fieldClass}
          >
            <option value="">All providers</option>
            {providerEnum.enumValues.map((p) => (
              <option key={p} value={p}>
                {PROVIDER_NAMES[p]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-foreground/70">Model</span>
          <input
            name="model"
            list="models"
            defaultValue={filters.model ?? ""}
            placeholder="Any model"
            autoComplete="off"
            className={`${fieldClass} w-44`}
          />
          <datalist id="models">
            {models.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-foreground/70">From (UTC)</span>
          <input
            type="date"
            name="from"
            defaultValue={filters.from ?? ""}
            className={fieldClass}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-foreground/70">To (UTC)</span>
          <input
            type="date"
            name="to"
            defaultValue={filters.to ?? ""}
            className={fieldClass}
          />
        </label>
        <div className="flex items-center gap-3">
          <button
            type="submit"
            className="rounded-md bg-foreground px-3 py-1.5 font-medium text-background"
          >
            Apply
          </button>
          {isFiltered && (
            <Link href="/usage" className="text-foreground/70 underline">
              Clear
            </Link>
          )}
        </div>
      </form>

      {page.rows.length === 0 ? (
        <p className="rounded-lg border border-dashed border-foreground/20 p-8 text-center text-foreground/70">
          {isFiltered || cursor
            ? "No usage events match these filters."
            : "No usage recorded yet. Send usage to POST /api/usage to see it here."}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-foreground/10">
          <table
            className="w-full min-w-[60rem] text-left text-sm"
            data-testid="usage-events"
          >
            <thead className="border-b border-foreground/10 text-foreground/60">
              <tr>
                {[
                  "Time (UTC)",
                  "Project",
                  "Provider",
                  "Model",
                  "Input",
                  "Cached",
                  "Output",
                  "Cost",
                  "Request ID",
                ].map((heading, i) => (
                  <th
                    key={heading}
                    scope="col"
                    className={`px-3 py-3 font-medium ${i >= 4 && i <= 7 ? "text-right" : ""}`}
                  >
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {page.rows.map((event) => (
                <tr
                  key={event.id}
                  className="border-b border-foreground/10 last:border-0"
                >
                  <td className="whitespace-nowrap px-3 py-2">
                    <time dateTime={event.occurredAt.toISOString()}>
                      {utcTime.format(event.occurredAt)}
                    </time>
                  </td>
                  <td className="px-3 py-2">{event.projectName}</td>
                  <td className="px-3 py-2">
                    {PROVIDER_NAMES[event.provider]}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">{event.model}</td>
                  <td className="px-3 py-2 text-right">
                    {count(event.inputTokens)}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {count(event.cachedInputTokens)}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {count(event.outputTokens)}
                  </td>
                  <td className="px-3 py-2 text-right font-medium">
                    {formatUsd(Number(event.costUsd))}
                  </td>
                  <td className="max-w-48 truncate px-3 py-2 font-mono text-xs text-foreground/70">
                    {event.requestId ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <nav
        aria-label="Pagination"
        className="flex items-center justify-between text-sm"
      >
        {cursor ? (
          <Link
            href={`/usage${usageQuery(withoutCursor)}`}
            className="underline"
          >
            ← Newest
          </Link>
        ) : (
          <span />
        )}
        {page.next && (
          <Link
            href={`/usage${usageQuery(withoutCursor, page.next)}`}
            className="underline"
            rel="next"
          >
            Older events →
          </Link>
        )}
      </nav>
    </main>
  );
}
