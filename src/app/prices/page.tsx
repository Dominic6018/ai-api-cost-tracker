import type { Metadata } from "next";
import Link from "next/link";
import { db } from "@/db";
import { listModelPrices } from "@/db/pricing";
import { requireUser } from "@/lib/auth";
import {
  formatRate,
  needsRecheck,
  priceHistories,
  STALE_CHECK_DAYS,
  type PriceStatus,
} from "@/lib/prices";
import { logoutAction } from "../login/actions";

export const metadata: Metadata = { title: "Prices · AI API Cost Tracker" };

// Reads the database on every request; never prerender at build time.
export const dynamic = "force-dynamic";

const STATUS_LABELS: Record<PriceStatus, string> = {
  current: "Current",
  scheduled: "Scheduled",
  ended: "Ended",
};

const utcDateTime = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

const rate = (value: string | null) =>
  value === null ? "—" : formatRate(value);

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export default async function PricesPage() {
  const user = await requireUser("/prices");
  const now = new Date();
  const histories = priceHistories(await listModelPrices(db), now);

  return (
    <main className="mx-auto flex min-h-screen max-w-6xl flex-col gap-8 px-4 py-12 sm:px-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <Link href="/" className="text-sm text-foreground/60 underline">
            AI API Cost Tracker
          </Link>
          <h1 className="text-3xl font-semibold tracking-tight">Prices</h1>
        </div>
        <nav className="flex flex-wrap items-center gap-4 text-sm">
          <Link href="/overview" className="underline">
            Spend overview
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
          <Link
            href="/prices/new"
            className="rounded-md bg-foreground px-4 py-2 font-medium text-background"
          >
            Add price
          </Link>
        </nav>
      </header>

      <p className="max-w-3xl text-sm text-foreground/70">
        USD per million tokens. Costs are calculated with the price in effect
        when usage occurred, so each model keeps its history. Every price shows
        where it was read and when it was last checked there; a check that is
        missing or more than {STALE_CHECK_DAYS} days old is marked{" "}
        <strong>Recheck</strong>. Add a price when a provider changes its rates,
        or load the bundled prices with <code>npm run db:seed</code>.
      </p>

      {histories.length === 0 ? (
        <p className="rounded-lg border border-dashed border-foreground/20 p-8 text-center text-foreground/70">
          No prices yet. Load the seed prices with <code>npm run db:seed</code>.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-foreground/10">
          <table className="w-full min-w-[60rem] text-left text-sm">
            <thead className="border-b border-foreground/10 text-foreground/60">
              <tr>
                <th scope="col" className="px-4 py-3 font-medium">
                  Model
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  Status
                </th>
                <th scope="col" className="px-4 py-3 text-right font-medium">
                  Input
                </th>
                <th scope="col" className="px-4 py-3 text-right font-medium">
                  Cached input
                </th>
                <th scope="col" className="px-4 py-3 text-right font-medium">
                  Cache write
                </th>
                <th scope="col" className="px-4 py-3 text-right font-medium">
                  Output
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  Applies (UTC)
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  Source
                </th>
              </tr>
            </thead>
            <tbody>
              {histories.flatMap(({ provider, model, prices }) =>
                prices.map(({ row, status }, index) => {
                  const recheck = needsRecheck(row.checkedOn, now);
                  return (
                    <tr
                      key={row.id}
                      data-testid="price"
                      data-model={model}
                      className="border-b border-foreground/10 align-top last:border-0"
                    >
                      <td className="px-4 py-3">
                        {index === 0 ? (
                          <>
                            <span className="font-mono">{model}</span>
                            <span className="block text-xs text-foreground/60">
                              {provider}
                            </span>
                          </>
                        ) : (
                          <span className="sr-only">
                            {provider} {model}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={
                            status === "current"
                              ? "font-medium"
                              : "text-foreground/60"
                          }
                        >
                          {STATUS_LABELS[status]}
                        </span>
                        {status !== "ended" && (
                          <Link
                            href={`/prices/${row.id}/end`}
                            className="block text-xs underline"
                            aria-label={`End the ${model} price from ${utcDateTime.format(row.effectiveFrom)}`}
                          >
                            End
                          </Link>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        {rate(row.inputPerMTokUsd)}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        {rate(row.cachedInputPerMTokUsd)}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        {rate(row.cacheWritePerMTokUsd)}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        {rate(row.outputPerMTokUsd)}
                        {row.longContextThresholdTokens !== null && (
                          <span className="block text-xs text-foreground/60">
                            Over{" "}
                            {row.longContextThresholdTokens.toLocaleString(
                              "en-US",
                            )}{" "}
                            input tokens: {rate(row.longInputPerMTokUsd)} in,{" "}
                            {rate(row.longOutputPerMTokUsd)} out
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-xs">
                        from {utcDateTime.format(row.effectiveFrom)}
                        {row.effectiveTo && (
                          <span className="block">
                            until {utcDateTime.format(row.effectiveTo)}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-xs" data-testid="source">
                        {row.sourceUrl ? (
                          <a
                            href={row.sourceUrl}
                            className="underline"
                            target="_blank"
                            rel="noreferrer"
                          >
                            {hostOf(row.sourceUrl)}
                          </a>
                        ) : (
                          <span className="text-foreground/60">
                            Source not recorded
                          </span>
                        )}
                        <span className="block text-foreground/60">
                          {row.checkedOn
                            ? `Checked ${row.checkedOn}`
                            : "Check date not recorded"}
                        </span>
                        {row.recordedByEmail && (
                          <span className="block text-foreground/60">
                            Added by {row.recordedByEmail}
                          </span>
                        )}
                        {recheck && <strong className="block">Recheck</strong>}
                        {row.endSourceUrl && (
                          <span className="mt-1 block" data-testid="ended">
                            Ended per{" "}
                            <a
                              href={row.endSourceUrl}
                              className="underline"
                              target="_blank"
                              rel="noreferrer"
                            >
                              {hostOf(row.endSourceUrl)}
                            </a>
                            <span className="block text-foreground/60">
                              Checked {row.endCheckedOn}
                              {row.endedByEmail && `, by ${row.endedByEmail}`}
                            </span>
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                }),
              )}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
