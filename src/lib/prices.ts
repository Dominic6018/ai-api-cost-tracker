/**
 * The price list: which prices apply now, and how recently each was
 * checked against its source.
 */

import { selectEffectivePricing, type PricingRow } from "./pricing";

const DAY_MS = 24 * 60 * 60 * 1000;

/** A check older than this is flagged for re-checking. */
export const STALE_CHECK_DAYS = 90;

export type PriceStatus = "current" | "scheduled" | "ended";

export interface PriceListRow extends PricingRow {
  id: string;
  provider: string;
  model: string;
  sourceUrl: string | null;
  /** "YYYY-MM-DD", or null when not recorded. */
  checkedOn: string | null;
}

export interface ModelPriceHistory<Row extends PriceListRow> {
  provider: string;
  model: string;
  /** Newest start first, each with its status at `now`. */
  prices: Array<{ row: Row; status: PriceStatus }>;
}

/**
 * Groups prices by provider and model, newest first. A price is current
 * when the cost lookup would use it at `now` (the most recently started
 * price in effect), scheduled when it starts later, and ended otherwise:
 * past its end, or superseded by a newer price.
 */
export function priceHistories<Row extends PriceListRow>(
  rows: readonly Row[],
  now: Date,
): ModelPriceHistory<Row>[] {
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const key = `${row.provider}\u0000${row.model}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.values()]
    .map((history) => {
      const effective = selectEffectivePricing(history, now);
      const current = effective.found ? effective.row : undefined;
      return {
        provider: history[0].provider,
        model: history[0].model,
        prices: [...history]
          .sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime())
          .map((row) => ({
            row,
            status: (row === current
              ? "current"
              : row.effectiveFrom.getTime() > now.getTime()
                ? "scheduled"
                : "ended") as PriceStatus,
          })),
      };
    })
    .sort(
      (a, b) =>
        a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model),
    );
}

/**
 * Whether a check date is missing or more than 90 days before `now`'s
 * UTC day.
 */
export function needsRecheck(checkedOn: string | null, now: Date): boolean {
  if (checkedOn === null) return true;
  const checked = Date.parse(`${checkedOn}T00:00:00Z`);
  const today = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  return today - checked > STALE_CHECK_DAYS * DAY_MS;
}

/**
 * A per-million-token rate for display, exactly as stored but without
 * trailing zeros beyond the cents: "3.000000" → "$3.00",
 * "0.037500" → "$0.0375".
 */
export function formatRate(value: string): string {
  const [whole, fraction = ""] = value.split(".");
  const trimmed = fraction.replace(/0+$/, "").padEnd(2, "0");
  return `$${whole}.${trimmed}`;
}

/** A batch multiplier as a share of the standard price: "0.500" → "50%". */
export function formatBatchMultiplier(value: string | null): string {
  if (value === null) return "—";
  const [whole, fraction = ""] = value.split(".");
  // Exact: three decimals of a multiplier are a tenth of a percent.
  const tenths = Number(whole) * 1000 + Number(fraction.padEnd(3, "0"));
  return `${tenths / 10}%`;
}
