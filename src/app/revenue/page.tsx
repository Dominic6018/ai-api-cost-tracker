import type { Metadata } from "next";
import Link from "next/link";
import { DashboardNav } from "../dashboard-nav";
import { db } from "@/db";
import { getRevenueInputs } from "@/db/revenue";
import { requireUser } from "@/lib/auth";
import {
  formatEntryUsd,
  monthLabel,
  monthStart,
  nextMonth,
  parseBillingMonth,
} from "@/lib/billing";
import { formatUsd } from "@/lib/cost";
import { formatShare, revenueReport } from "@/lib/revenue";

export const metadata: Metadata = {
  title: "Revenue and AI API cost · AI API Cost Tracker",
};

export const dynamic = "force-dynamic";

type SearchParams = Promise<{ month?: string | string[] }>;

/** The first of the month before the one starting `month`. */
function previousMonth(month: string): string {
  const day = new Date(`${month}T00:00:00Z`);
  return monthStart(new Date(day.getTime() - 86_400_000));
}

function Amount({ micros }: { micros: bigint }) {
  return (
    <span title={formatEntryUsd(micros)}>
      {formatUsd(Number(micros) / 1_000_000)}
    </span>
  );
}

export default async function RevenuePage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const user = await requireUser("/revenue");
  const params = await searchParams;
  const current = monthStart(new Date());
  const requested = Array.isArray(params.month)
    ? params.month[0]
    : params.month;
  const parsed = requested ? parseBillingMonth(requested) : null;
  const month = parsed?.ok ? parsed.value : current;

  const report = revenueReport(
    await getRevenueInputs(db, { organizationId: user.organizationId }, month),
  );
  const { total } = report;
  const inProgress = month >= current;

  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col gap-6 px-4 py-12 sm:px-8">
      <DashboardNav user={user} current="/revenue" />
      <div className="flex flex-col gap-1">
        <h1 className="text-3xl font-semibold tracking-tight">
          Revenue and AI API cost
        </h1>
      </div>
      <p className="max-w-3xl text-sm text-foreground/70">
        What each customer was billed in the month, from the{" "}
        <a
          href="https://github.com/Dominic6018/ai-api-cost-tracker/blob/main/docs/BILLING.md"
          className="underline"
        >
          billing ledger
        </a>
        , against what their usage cost at provider prices. The difference is
        revenue minus AI API cost only: hosting, staff and every other cost are
        left out, so it isn&apos;t profit. Revenue counts the month&apos;s plan
        fees and usage charges, and adjustments made during it; applied credit
        is a way of paying, so it doesn&apos;t reduce revenue. Months are UTC.
      </p>

      <nav className="flex items-center gap-4 text-sm" aria-label="Month">
        <Link
          href={`/revenue?month=${monthLabel(previousMonth(month))}`}
          className="underline"
        >
          ← {monthLabel(previousMonth(month))}
        </Link>
        <span className="font-medium tabular-nums">{monthLabel(month)}</span>
        {!inProgress && (
          <Link
            href={`/revenue?month=${monthLabel(nextMonth(month))}`}
            className="underline"
          >
            {monthLabel(nextMonth(month))} →
          </Link>
        )}
      </nav>

      {inProgress && (
        <p className="text-sm text-foreground/70">
          This month isn&apos;t over: its plan fees and usage charges are posted
          once it is, so revenue here is only what&apos;s been billed so far.
        </p>
      )}
      {total.unpriced > 0 && (
        <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm">
          {total.unpriced.toLocaleString("en-US")} request(s) this month have no
          price yet, so AI API cost is understated. Add the missing prices and
          run <code>npm run reprice</code>.
        </p>
      )}

      {report.rows.length === 0 ? (
        <p className="text-foreground/60">
          Nothing billed or used in {monthLabel(month)}.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-foreground/10">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-foreground/10 text-foreground/60">
              <tr>
                <th scope="col" className="px-4 py-3 font-medium">
                  Customer
                </th>
                <th scope="col" className="px-4 py-3 text-right font-medium">
                  Revenue
                </th>
                <th scope="col" className="px-4 py-3 text-right font-medium">
                  AI API cost
                </th>
                <th scope="col" className="px-4 py-3 text-right font-medium">
                  Revenue minus AI API cost
                </th>
                <th
                  scope="col"
                  className="px-4 py-3 text-right font-medium"
                  title="Revenue minus AI API cost, as a share of revenue"
                >
                  Share of revenue
                </th>
              </tr>
            </thead>
            <tbody>
              {report.rows.map((row) => (
                <tr
                  key={row.customerId ?? ""}
                  className="border-b border-foreground/10"
                >
                  <td className="px-4 py-3">
                    {row.customerId === null ? (
                      <span className="text-foreground/60">
                        No customer on the usage
                      </span>
                    ) : (
                      <>
                        <span>{row.name ?? row.customerId}</span>{" "}
                        <span className="text-foreground/60">
                          {row.name
                            ? row.customerId
                            : "(not a billing customer)"}
                        </span>
                      </>
                    )}
                    {row.unpriced > 0 && (
                      <span className="ml-2 text-amber-600 dark:text-amber-400">
                        {row.unpriced} unpriced
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    <Amount micros={row.revenueMicros} />
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    <Amount micros={row.costMicros} />
                  </td>
                  <td
                    className={`px-4 py-3 text-right tabular-nums ${
                      row.differenceMicros < 0n
                        ? "font-medium text-red-600 dark:text-red-400"
                        : ""
                    }`}
                  >
                    <Amount micros={row.differenceMicros} />
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {formatShare(row.sharePermille)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot className="font-medium">
              <tr>
                <td className="px-4 py-3">Total</td>
                <td className="px-4 py-3 text-right tabular-nums">
                  <Amount micros={total.revenueMicros} />
                </td>
                <td className="px-4 py-3 text-right tabular-nums">
                  <Amount micros={total.costMicros} />
                </td>
                <td className="px-4 py-3 text-right tabular-nums">
                  <Amount micros={total.differenceMicros} />
                </td>
                <td className="px-4 py-3 text-right tabular-nums">
                  {formatShare(total.sharePermille)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </main>
  );
}
