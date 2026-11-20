import type { Metadata } from "next";
import { db } from "@/db";
import { getStatement, openPortal } from "@/db/billing-portal";
import {
  describeBalance,
  ENTRY_KIND_LABELS,
  formatStatementUsd,
  INVALID_PORTAL_MESSAGE,
} from "@/lib/portal";

export const metadata: Metadata = {
  title: "Your statement",
  // Not the app's own description, which is about tracking AI API cost.
  description: "A read-only billing statement.",
  // The link is the credential: keep it out of Referer headers and search.
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

const utcDate = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  year: "numeric",
  month: "short",
  day: "numeric",
});

/**
 * Public and read-only: the link alone opens one customer's statement.
 * It has no forms and no links into the dashboard.
 */
export default async function PortalPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const now = new Date();
  const opened = await openPortal(db, token, now);

  if (!opened) {
    return (
      <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-4 px-4 py-12">
        <h1 className="text-2xl font-semibold tracking-tight">Statement</h1>
        <p role="alert" className="text-sm" data-status="invalid">
          {INVALID_PORTAL_MESSAGE}
        </p>
      </main>
    );
  }

  const { customer, organizationName } = opened;
  const statement = await getStatement(db, customer, now);
  const balance = describeBalance(statement.balanceMicros);

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-8 px-4 py-12 sm:px-8">
      <header className="flex flex-col gap-1">
        <p className="text-sm text-foreground/60">{organizationName}</p>
        <h1 className="text-3xl font-semibold tracking-tight">
          {customer.name}
        </h1>
        <p className="text-sm text-foreground/60">
          Statement as of {utcDate.format(now)} (UTC). Read only.
        </p>
      </header>

      <dl className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-lg border border-foreground/10 p-4">
          <dt className="text-sm text-foreground/60">{balance.label}</dt>
          <dd
            className="text-2xl font-semibold tabular-nums"
            data-testid="portal-balance"
          >
            {formatStatementUsd(balance.micros)}
          </dd>
        </div>
        <div className="rounded-lg border border-foreground/10 p-4">
          <dt className="text-sm text-foreground/60">Plan this month</dt>
          <dd className="text-lg font-medium">
            {statement.plan ? (
              <>
                {statement.plan.name}
                <span className="block text-sm font-normal text-foreground/70 tabular-nums">
                  {formatStatementUsd(statement.plan.monthlyFeeMicros)} a month
                </span>
              </>
            ) : (
              <span className="text-foreground/60">No plan</span>
            )}
          </dd>
        </div>
        <div className="rounded-lg border border-foreground/10 p-4">
          <dt className="text-sm text-foreground/60">Credit available</dt>
          <dd className="text-lg font-medium tabular-nums">
            {formatStatementUsd(statement.credit.usableMicros)}
            {statement.credit.grants
              .filter((grant) => grant.expiresAt)
              .map((grant, i) => (
                <span
                  key={i}
                  className="block text-sm font-normal text-foreground/70"
                >
                  {formatStatementUsd(grant.remainingMicros)} until{" "}
                  {utcDate.format(grant.expiresAt!)}
                </span>
              ))}
          </dd>
        </div>
      </dl>

      <section
        className="flex flex-col gap-3"
        aria-labelledby="entries-heading"
      >
        <h2 id="entries-heading" className="text-lg font-semibold">
          Entries
        </h2>
        {statement.entries.length === 0 ? (
          <p className="text-sm text-foreground/70">No entries yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-foreground/10">
            <table className="w-full min-w-[32rem] text-left text-sm">
              <thead className="border-b border-foreground/10 text-foreground/60">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Date
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Type
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Description
                  </th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">
                    Amount
                  </th>
                </tr>
              </thead>
              <tbody>
                {statement.entries.map((entry) => (
                  <tr
                    key={entry.id}
                    className="border-b border-foreground/10 last:border-0"
                  >
                    <td className="px-4 py-3 tabular-nums">
                      {utcDate.format(entry.createdAt)}
                    </td>
                    <td className="px-4 py-3">
                      {ENTRY_KIND_LABELS[entry.kind]}
                    </td>
                    <td className="px-4 py-3">{entry.description}</td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {formatStatementUsd(entry.amountMicros)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {statement.more && (
          <p className="text-sm text-foreground/60">
            Showing the latest {statement.entries.length} entries. Ask{" "}
            {organizationName} for older ones.
          </p>
        )}
        <p className="text-xs text-foreground/60">
          Charges are positive; payments and credit are negative. Amounts are in
          US dollars.
        </p>
      </section>
    </main>
  );
}
