import type { Metadata } from "next";
import { DashboardNav } from "../dashboard-nav";
import { db } from "@/db";
import { listProjects } from "@/db/projects";
import { getCurrentPrices, getSavingsInputs } from "@/db/savings";
import { organizationScope } from "@/db/scope";
import { requireUser } from "@/lib/auth";
import { formatEntryUsd } from "@/lib/billing";
import { formatUsd } from "@/lib/cost";
import { estimateSavings } from "@/lib/savings";
import { comparisonPeriods } from "@/lib/spend-change";

export const metadata: Metadata = {
  title: "Savings estimates · AI API Cost Tracker",
};

export const dynamic = "force-dynamic";

type SearchParams = Promise<{ project?: string | string[] }>;

const day = (d: Date) => d.toISOString().slice(0, 10);

function Amount({ micros }: { micros: bigint }) {
  return (
    <span title={formatEntryUsd(micros)}>
      {formatUsd(Number(micros) / 1_000_000)}
    </span>
  );
}

export default async function SavingsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const user = await requireUser("/savings");
  const params = await searchParams;
  const scope = organizationScope(user);
  const projects = await listProjects(db, scope);
  const requested = Array.isArray(params.project)
    ? params.project[0]
    : params.project;
  // Only a project in this organization; anything else means all of them.
  const project = projects.find((p) => p.id === requested);

  const now = new Date();
  // The last 30 full UTC days.
  const period = comparisonPeriods(now, "30d").after;
  const inputs = await getSavingsInputs(db, scope, period, project?.id);
  const report = estimateSavings(
    inputs.workloads,
    await getCurrentPrices(db, now),
  );

  const cards = [
    {
      label: "Batching",
      micros: report.batchMicros,
      note: "If all of it had gone through the provider's Batch API, at the model's batch price. Batch results can take up to a day.",
    },
    {
      label: "Caching, per 10% of input",
      micros: report.cachingPer10PercentMicros,
      note: "For each 10% of uncached input read from the prompt cache instead, before the cost of writing it to the cache.",
    },
    {
      label: "Model choice",
      micros: report.alternativeMicros,
      note: "The same tokens on the cheapest other model from the same provider. Says nothing about whether it would do as well.",
    },
  ];

  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col gap-6 px-4 py-12 sm:px-8">
      <DashboardNav user={user} current="/savings" />
      <div className="flex flex-col gap-1">
        <h1 className="text-3xl font-semibold tracking-tight">
          Savings estimates
        </h1>
      </div>
      <p className="max-w-3xl text-sm text-foreground/70">
        <strong>These are estimates, not promises.</strong> Each one reprices
        the same measured usage, the last 30 full days ({day(period.from)} to{" "}
        {day(new Date(period.to.getTime() - 1))}, UTC) of standard-tier
        requests, at the price table&apos;s current rates, under one assumption
        stated with it. None of them knows whether your prompts repeat, whether
        the work can wait, or whether a cheaper model is good enough for it:
        test before you switch. They aren&apos;t additive, since they overlap.
      </p>

      <form method="get" className="flex items-center gap-2 text-sm">
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

      {(inputs.unpriced > 0 || inputs.otherTiers > 0) && (
        <p
          className="text-sm text-foreground/70"
          data-testid="savings-left-out"
        >
          Left out:{" "}
          {inputs.unpriced > 0 &&
            `${inputs.unpriced.toLocaleString("en-US")} request(s) with no price yet`}
          {inputs.unpriced > 0 && inputs.otherTiers > 0 && " and "}
          {inputs.otherTiers > 0 &&
            `${inputs.otherTiers.toLocaleString("en-US")} batch, flex or fast request(s), already at another tier's price`}
          .
        </p>
      )}

      {report.rows.length === 0 ? (
        <p className="text-foreground/60">
          No priced standard-tier usage in the last 30 full days.
        </p>
      ) : (
        <>
          <section className="grid gap-4 sm:grid-cols-3">
            {cards.map((card) => (
              <div
                key={card.label}
                className="flex flex-col gap-1 rounded-lg border border-foreground/10 p-5"
              >
                <p className="text-sm text-foreground/60">
                  {card.label}{" "}
                  <span className="rounded bg-foreground/10 px-1.5 py-0.5 text-xs">
                    Estimate
                  </span>
                </p>
                <p className="text-2xl font-semibold tabular-nums">
                  up to <Amount micros={card.micros} />
                </p>
                <p className="text-xs text-foreground/50">{card.note}</p>
              </div>
            ))}
          </section>
          <p className="text-sm text-foreground/70">
            Out of <Amount micros={report.costMicros} /> recorded for this
            usage.
          </p>

          <div className="overflow-x-auto rounded-lg border border-foreground/10">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-foreground/10 text-foreground/60">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Model
                  </th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">
                    Cost, 30 days
                  </th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">
                    Batching
                  </th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">
                    Caching, per 10%
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Cheaper model
                  </th>
                </tr>
              </thead>
              <tbody>
                {report.rows.map((row) => (
                  <tr
                    key={`${row.provider}/${row.model}`}
                    className="border-b border-foreground/10 last:border-0"
                  >
                    <td className="px-4 py-3">
                      {row.model}{" "}
                      <span className="text-foreground/60">{row.provider}</span>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      <Amount micros={row.costMicros} />
                    </td>
                    {!row.priced ? (
                      <td colSpan={3} className="px-4 py-3 text-foreground/60">
                        No current price for this model, so nothing to estimate
                      </td>
                    ) : (
                      <>
                        <td className="px-4 py-3 text-right tabular-nums">
                          {row.batch ? (
                            <Amount micros={row.batch.savingMicros} />
                          ) : (
                            <span className="text-foreground/50">
                              No batch price
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums">
                          {row.cachingPer10Percent !== null ? (
                            <Amount micros={row.cachingPer10Percent} />
                          ) : (
                            <span className="text-foreground/50">—</span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          {row.alternative ? (
                            <>
                              {row.alternative.model}:{" "}
                              <Amount micros={row.alternative.costMicros} />{" "}
                              <span className="text-foreground/60">
                                (
                                <Amount
                                  micros={row.alternative.savingMicros}
                                />{" "}
                                less)
                              </span>
                            </>
                          ) : (
                            <span className="text-foreground/50">
                              None cheaper from {row.provider}
                            </span>
                          )}
                        </td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-foreground/60">
            Method: each model&apos;s tokens by kind (uncached and cached input,
            cache writes, output) are repriced at its current standard rates,
            without long-prompt tiers, audio or image rates. Batching applies
            the model&apos;s batch multiplier to the recorded cost. A cheaper
            model is compared on the same tokens, though another model may use a
            different number of tokens for the same text.
          </p>
        </>
      )}
    </main>
  );
}
