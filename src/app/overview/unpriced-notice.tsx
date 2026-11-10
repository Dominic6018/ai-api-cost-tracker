import Link from "next/link";
import type { UnpricedSummary } from "@/db/unpriced";

const MISSING: Record<UnpricedSummary["models"][number]["reason"], string> = {
  no_pricing: "no price",
  no_tier_pricing: "no price for its tier",
  no_batch_pricing: "no batch price",
  no_audio_pricing: "no audio rates",
  no_web_search_pricing: "no web search price",
};

/** Usage kept without a price, which no total on the page includes. */
export function UnpricedNotice({
  summary,
  canManagePrices,
}: {
  summary: UnpricedSummary;
  canManagePrices: boolean;
}) {
  if (summary.events === 0) return null;
  const shown = summary.models.slice(0, 5);
  return (
    <section
      aria-labelledby="unpriced"
      className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm"
    >
      <h2 id="unpriced" className="font-medium">
        {summary.events.toLocaleString("en-US")} request
        {summary.events === 1 ? "" : "s"} in the last 30 days{" "}
        {summary.events === 1 ? "has" : "have"} no price yet
      </h2>
      <p className="mt-1 text-foreground/70">
        They&apos;re stored, but not in any total, budget or export below.
        {canManagePrices
          ? " Add the missing price, then run npm run reprice to price them."
          : " An admin can add the missing price and price them."}
      </p>
      <ul className="mt-2 list-disc pl-5 text-foreground/80">
        {shown.map((m) => (
          <li key={`${m.provider}/${m.model}/${m.reason}`}>
            <span className="font-mono text-xs">
              {m.provider}/{m.model}
            </span>
            : {m.events.toLocaleString("en-US")}, {MISSING[m.reason]}
          </li>
        ))}
      </ul>
      {canManagePrices && (
        <Link href="/prices/new" className="mt-2 inline-block underline">
          Add a price
        </Link>
      )}
    </section>
  );
}
