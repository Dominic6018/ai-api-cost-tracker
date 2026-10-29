import type { Metadata } from "next";
import Link from "next/link";
import { db } from "@/db";
import { getSpendOverview, type SpendTotals } from "@/db/spend";
import { requireUser } from "@/lib/auth";
import { formatUsd } from "@/lib/cost";
import { logoutAction } from "../login/actions";

export const metadata: Metadata = {
  title: "Spend overview · AI API Cost Tracker",
};

export const dynamic = "force-dynamic";

const WINDOWS: { key: keyof Omit<SpendTotals, "events">; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "month", label: "This month" },
  { key: "last30Days", label: "Last 30 days" },
];

const usd = (amount: string) => formatUsd(Number(amount));

const utcDate = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export default async function OverviewPage() {
  const user = await requireUser("/overview");
  const overview = await getSpendOverview(db);
  const { totals, windows } = overview;
  const hasUsage = totals.events > 0;

  return (
    <main className="mx-auto flex min-h-screen max-w-4xl flex-col gap-8 px-4 py-12 sm:px-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <Link href="/" className="text-sm text-foreground/60 underline">
            AI API Cost Tracker
          </Link>
          <h1 className="text-3xl font-semibold tracking-tight">
            Spend overview
          </h1>
        </div>
        <nav className="flex flex-wrap items-center gap-4 text-sm">
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

      <section aria-label="Total spend" className="grid gap-4 sm:grid-cols-3">
        {WINDOWS.map(({ key, label }) => (
          <div
            key={key}
            className="flex flex-col gap-1 rounded-lg border border-foreground/10 p-5"
          >
            <p className="text-sm text-foreground/60">{label}</p>
            <p
              className="text-3xl font-semibold tabular-nums"
              data-window={key}
            >
              {usd(totals[key])}
            </p>
            <p className="text-xs text-foreground/50">
              since {utcDate.format(windows[key])} UTC
            </p>
          </div>
        ))}
      </section>

      {!hasUsage ? (
        <section className="rounded-lg border border-dashed border-foreground/20 p-8 text-center text-foreground/70">
          <p className="font-medium text-foreground">No usage recorded yet</p>
          <p className="mt-1 text-sm">
            Create an API key with <code>npm run api-key -- create</code> and
            send usage to <code>POST /api/usage</code>. Spend appears here as it
            arrives.
          </p>
        </section>
      ) : (
        <section aria-labelledby="by-project" className="flex flex-col gap-3">
          <h2 id="by-project" className="text-xl font-medium">
            By project
          </h2>
          <div className="overflow-x-auto rounded-lg border border-foreground/10">
            <table className="w-full min-w-[32rem] text-left text-sm">
              <thead className="border-b border-foreground/10 text-foreground/60">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Project
                  </th>
                  {WINDOWS.map(({ key, label }) => (
                    <th
                      key={key}
                      scope="col"
                      className="px-4 py-3 text-right font-medium"
                    >
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {overview.projects.map((project) => (
                  <tr
                    key={project.id}
                    className="border-b border-foreground/10 last:border-0"
                  >
                    <td className="px-4 py-3">
                      <span className="font-medium">{project.name}</span>{" "}
                      <span className="font-mono text-xs text-foreground/60">
                        {project.slug}
                      </span>
                    </td>
                    {WINDOWS.map(({ key }) => (
                      <td
                        key={key}
                        className="px-4 py-3 text-right tabular-nums"
                      >
                        {usd(project[key])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <p className="text-xs text-foreground/50">
        Today and this month start at midnight UTC. Last 30 days is a rolling
        window of 30 × 24 hours. Usage counts by its <code>occurredAt</code>{" "}
        time.
      </p>
    </main>
  );
}
