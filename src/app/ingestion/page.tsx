import type { Metadata } from "next";
import Link from "next/link";
import { db } from "@/db";
import { getIngestionHealth } from "@/db/ingestion-health";
import { organizationScope } from "@/db/scope";
import { requireUser } from "@/lib/auth";

export const metadata: Metadata = {
  title: "Ingestion · AI API Cost Tracker",
};

export const dynamic = "force-dynamic";

const DAYS = 7;

const COLUMNS = [
  { key: "stored", label: "Stored", hint: "New events with a price" },
  {
    key: "unpriced",
    label: "Unpriced",
    hint: "New events waiting for a price",
  },
  {
    key: "replayed",
    label: "Replayed",
    hint: "Retries that returned the stored event",
  },
  {
    key: "conflict",
    label: "Conflicts",
    hint: "A request id reused for different usage",
  },
  {
    key: "invalid",
    label: "Invalid",
    hint: "Bodies or spans that failed validation",
  },
] as const;

const count = (n: number) => (n === 0 ? "—" : n.toLocaleString("en-US"));

export default async function IngestionPage() {
  const user = await requireUser("/ingestion");
  const rows = await getIngestionHealth(db, organizationScope(user), DAYS);

  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col gap-6 px-4 py-12 sm:px-8">
      <div className="flex flex-col gap-1">
        <Link href="/overview" className="text-sm text-foreground/60 underline">
          Spend overview
        </Link>
        <h1 className="text-3xl font-semibold tracking-tight">Ingestion</h1>
      </div>
      <p className="max-w-3xl text-sm text-foreground/70">
        What each project sent through <code>POST /api/usage</code> and
        OpenTelemetry over the last {DAYS} days (UTC), by outcome. Conflicts and
        invalid requests mean usage that wasn&apos;t stored; unpriced events are
        stored but in no total until their price is added. Requests with an
        unknown key aren&apos;t counted here.
      </p>
      {rows.length === 0 ? (
        <p className="text-foreground/60">Nothing received in this period.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-foreground/10">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-foreground/10 text-foreground/60">
              <tr>
                <th scope="col" className="px-4 py-3 font-medium">
                  Day
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  Project
                </th>
                {COLUMNS.map((c) => (
                  <th
                    key={c.key}
                    scope="col"
                    title={c.hint}
                    className="px-4 py-3 text-right font-medium"
                  >
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={`${row.day}|${row.projectId}`}
                  className="border-b border-foreground/10 last:border-0"
                >
                  <td className="px-4 py-3 whitespace-nowrap tabular-nums">
                    {row.day}
                  </td>
                  <td className="px-4 py-3">{row.projectName}</td>
                  {COLUMNS.map((c) => (
                    <td
                      key={c.key}
                      className={`px-4 py-3 text-right tabular-nums ${
                        (c.key === "conflict" || c.key === "invalid") &&
                        row[c.key] > 0
                          ? "font-medium text-red-600 dark:text-red-400"
                          : ""
                      }`}
                    >
                      {count(row[c.key])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
