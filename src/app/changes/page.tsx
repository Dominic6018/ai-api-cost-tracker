import type { Metadata } from "next";
import Link from "next/link";
import { db } from "@/db";
import { listProjects } from "@/db/projects";
import { organizationScope } from "@/db/scope";
import { getReferencePrices, getSpendChangeInputs } from "@/db/spend-change";
import { requireUser } from "@/lib/auth";
import { formatEntryUsd } from "@/lib/billing";
import { formatUsd } from "@/lib/cost";
import {
  COMPARISON_LABELS,
  COMPARISONS,
  comparisonPeriods,
  EFFECTS,
  explainSpendChange,
  parseComparison,
  type Effect,
} from "@/lib/spend-change";

export const metadata: Metadata = {
  title: "Why spend changed · AI API Cost Tracker",
};

export const dynamic = "force-dynamic";

type SearchParams = Promise<{
  compare?: string | string[];
  project?: string | string[];
}>;

const EFFECT_LABELS: Record<Effect, { label: string; hint: string }> = {
  volume: {
    label: "Volume",
    hint: "More or fewer requests, at the earlier mix of models and cost per request",
  },
  modelMix: {
    label: "Model mix",
    hint: "Requests moving between models, including models started or stopped",
  },
  tokensPerRequest: {
    label: "Tokens per request",
    hint: "Longer or shorter requests on the same model",
  },
  inputOutputMix: {
    label: "Input/output mix",
    hint: "On the same model, more or less of the tokens being output, which costs more than input",
  },
  cacheRate: {
    label: "Cache rate",
    hint: "On the same model, more or less of the input read from or written to the prompt cache",
  },
  price: {
    label: "Price",
    hint: "The model's rates in the price table at the end of each period",
  },
  other: {
    label: "Other",
    hint: "What the rates don't model: long-prompt tiers, batch, audio, images, web searches, a price change during a period, and rounding",
  },
};

const day = (d: Date) => d.toISOString().slice(0, 10);
const lastDay = (to: Date) => day(new Date(to.getTime() - 86_400_000));

function Amount({ micros, signed }: { micros: bigint; signed?: boolean }) {
  const text = formatUsd(Number(micros) / 1_000_000);
  return (
    <span title={formatEntryUsd(micros)}>
      {signed && micros > 0n ? `+${text}` : text}
    </span>
  );
}

export default async function ChangesPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const user = await requireUser("/changes");
  const params = await searchParams;
  const comparison = parseComparison(params.compare);
  const scope = organizationScope(user);
  const projects = await listProjects(db, scope);
  const requested = Array.isArray(params.project)
    ? params.project[0]
    : params.project;
  // Only a project in this organization; anything else means all of them.
  const project = projects.find((p) => p.id === requested);

  const periods = comparisonPeriods(new Date(), comparison);
  const inputs = await getSpendChangeInputs(db, scope, periods, project?.id);
  const prices = await getReferencePrices(db, inputs.models, periods);
  const result = explainSpendChange(inputs.models, prices);
  const unpriced = inputs.unpriced.before + inputs.unpriced.after;
  const query = (compare: string) =>
    `/changes?compare=${compare}${project ? `&project=${project.id}` : ""}`;

  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col gap-6 px-4 py-12 sm:px-8">
      <div className="flex flex-col gap-1">
        <Link href="/overview" className="text-sm text-foreground/60 underline">
          Spend overview
        </Link>
        <h1 className="text-3xl font-semibold tracking-tight">
          Why spend changed
        </h1>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-4">
        <nav className="flex flex-wrap gap-3 text-sm" aria-label="Compare">
          {COMPARISONS.map((c) =>
            c === comparison ? (
              <span key={c} className="font-medium" aria-current="page">
                {COMPARISON_LABELS[c]}
              </span>
            ) : (
              <Link key={c} href={query(c)} className="underline">
                {COMPARISON_LABELS[c]}
              </Link>
            ),
          )}
        </nav>
        <form method="get" className="flex items-center gap-2 text-sm">
          <input type="hidden" name="compare" value={comparison} />
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

      <p className="text-sm text-foreground/70" data-testid="change-summary">
        {project?.name ?? "All projects"} · {day(periods.before.from)} to{" "}
        {lastDay(periods.before.to)}: <Amount micros={result.beforeMicros} />{" "}
        over {result.beforeRequests.toLocaleString("en-US")} requests →{" "}
        {day(periods.after.from)} to {lastDay(periods.after.to)}:{" "}
        <Amount micros={result.afterMicros} /> over{" "}
        {result.afterRequests.toLocaleString("en-US")} requests · change{" "}
        <Amount micros={result.changeMicros} signed /> (UTC days)
      </p>

      {unpriced > 0 && (
        <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm">
          {unpriced.toLocaleString("en-US")} request(s) in these periods have no
          price yet and are left out. Add the missing prices and run{" "}
          <code>npm run reprice</code>.
        </p>
      )}

      {result.models.length === 0 ? (
        <p className="text-foreground/60">No priced usage in either period.</p>
      ) : (
        <>
          <section className="flex flex-col gap-2">
            <h2 className="text-lg font-semibold">What changed it</h2>
            <div className="overflow-x-auto rounded-lg border border-foreground/10">
              <table className="w-full text-left text-sm">
                <tbody>
                  {EFFECTS.map((effect) => (
                    <tr
                      key={effect}
                      className="border-b border-foreground/10 last:border-0"
                    >
                      <th scope="row" className="px-4 py-3 font-medium">
                        {EFFECT_LABELS[effect].label}
                        <div className="font-normal text-foreground/60">
                          {EFFECT_LABELS[effect].hint}
                        </div>
                      </th>
                      <td className="px-4 py-3 text-right tabular-nums">
                        <Amount micros={result.effects[effect]} signed />
                      </td>
                    </tr>
                  ))}
                  <tr className="font-medium">
                    <th scope="row" className="px-4 py-3">
                      Change
                    </th>
                    <td className="px-4 py-3 text-right tabular-nums">
                      <Amount micros={result.changeMicros} signed />
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="text-xs text-foreground/60">
              Method: each driver is swapped from the earlier period to the
              later one in the order shown, holding the others, so the amounts
              add up to the change exactly. A different order would give
              somewhat different amounts. Only priced requests count.
            </p>
          </section>

          <section className="flex flex-col gap-2">
            <h2 className="text-lg font-semibold">By model</h2>
            <div className="overflow-x-auto rounded-lg border border-foreground/10">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-foreground/10 text-foreground/60">
                  <tr>
                    <th scope="col" className="px-4 py-3 font-medium">
                      Model
                    </th>
                    <th
                      scope="col"
                      className="px-4 py-3 text-right font-medium"
                    >
                      Before
                    </th>
                    <th
                      scope="col"
                      className="px-4 py-3 text-right font-medium"
                    >
                      After
                    </th>
                    {EFFECTS.map((effect) => (
                      <th
                        key={effect}
                        scope="col"
                        className="px-4 py-3 text-right font-medium"
                      >
                        {EFFECT_LABELS[effect].label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.models.map((m) => (
                    <tr
                      key={`${m.provider}/${m.model}`}
                      className="border-b border-foreground/10 last:border-0"
                    >
                      <td className="px-4 py-3">
                        {m.model}{" "}
                        <span className="text-foreground/60">{m.provider}</span>
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        <Amount micros={m.before?.costMicros ?? 0n} />
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        <Amount micros={m.after?.costMicros ?? 0n} />
                      </td>
                      {EFFECTS.map((effect) => (
                        <td
                          key={effect}
                          className="px-4 py-3 text-right tabular-nums"
                        >
                          <Amount micros={m.effects[effect]} signed />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </main>
  );
}
