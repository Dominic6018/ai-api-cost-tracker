import type { Metadata } from "next";
import Link from "next/link";
import { db } from "@/db";
import { listAuditEntries } from "@/db/audit";
import { organizationScope } from "@/db/scope";
import {
  AUDIT_ACTION_LABELS,
  formatAuditDetails,
  parseAuditPage,
} from "@/lib/audit";
import { requirePermission } from "@/lib/auth";

export const metadata: Metadata = {
  title: "Audit log · AI API Cost Tracker",
};

export const dynamic = "force-dynamic";

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

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requirePermission("audit:read", "/audit");
  const page = parseAuditPage((await searchParams).page);
  const { entries, hasMore } = await listAuditEntries(
    db,
    organizationScope(user),
    page,
  );

  return (
    <main className="mx-auto flex min-h-screen max-w-6xl flex-col gap-6 px-4 py-12 sm:px-8">
      <div className="flex flex-col gap-1">
        <Link href="/overview" className="text-sm text-foreground/60 underline">
          Spend overview
        </Link>
        <h1 className="text-3xl font-semibold tracking-tight">Audit log</h1>
      </div>
      <p className="max-w-3xl text-sm text-foreground/70">
        Who changed projects, prices, accounts and API keys, newest first. Times
        are UTC.
      </p>

      {entries.length === 0 ? (
        <p className="text-foreground/60">
          {page === 1 ? "No changes recorded yet." : "No entries on this page."}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-foreground/10">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-foreground/10 text-foreground/60">
              <tr>
                <th scope="col" className="px-4 py-3 font-medium">
                  When
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  Who
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  Change
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  Details
                </th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr
                  key={entry.id}
                  className="border-b border-foreground/10 align-top last:border-0"
                >
                  <td className="px-4 py-3 whitespace-nowrap tabular-nums">
                    {utcTime.format(entry.occurredAt)}
                  </td>
                  <td className="px-4 py-3">{entry.actorLabel}</td>
                  <td className="px-4 py-3">
                    {AUDIT_ACTION_LABELS[entry.action]}{" "}
                    <span className="font-mono text-xs">{entry.target}</span>
                  </td>
                  <td className="px-4 py-3 text-xs text-foreground/70">
                    {formatAuditDetails(entry.details).map((line) => (
                      <div key={line} className="break-all">
                        {line}
                      </div>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <nav className="flex gap-4 text-sm">
        {page > 1 && (
          <Link href={`/audit?page=${page - 1}`} className="underline">
            Newer
          </Link>
        )}
        {hasMore && (
          <Link href={`/audit?page=${page + 1}`} className="underline">
            Older
          </Link>
        )}
      </nav>
    </main>
  );
}
