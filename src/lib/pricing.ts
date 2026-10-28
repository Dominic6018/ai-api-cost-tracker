import type { TokenPricing } from "./cost";

/** The fields of a `model_pricing` row needed to pick and apply a price. */
export interface PricingRow {
  effectiveFrom: Date;
  effectiveTo: Date | null;
  inputPerMTokUsd: string;
  outputPerMTokUsd: string;
  cachedInputPerMTokUsd: string | null;
}

export type PricingLookupResult<Row extends PricingRow = PricingRow> =
  | { found: true; row: Row; pricing: TokenPricing }
  | { found: false; reason: "no_pricing" };

/**
 * Whether a price applies at `at`. Ranges are half-open:
 * `effective_from` is inclusive and `effective_to` is exclusive.
 */
export function isEffectiveAt(row: PricingRow, at: Date): boolean {
  const time = at.getTime();
  return (
    row.effectiveFrom.getTime() <= time &&
    (row.effectiveTo === null || row.effectiveTo.getTime() > time)
  );
}

/**
 * Picks the price in effect at `at` from one model's pricing history.
 * If ranges overlap, the most recently started price wins.
 */
export function selectEffectivePricing<Row extends PricingRow>(
  rows: readonly Row[],
  at: Date,
): PricingLookupResult<Row> {
  let best: Row | undefined;
  for (const row of rows) {
    if (
      isEffectiveAt(row, at) &&
      (best === undefined ||
        row.effectiveFrom.getTime() > best.effectiveFrom.getTime())
    ) {
      best = row;
    }
  }
  if (best === undefined) return { found: false, reason: "no_pricing" };
  return { found: true, row: best, pricing: toTokenPricing(best) };
}

function parseUsd(name: string, value: string): number {
  const amount = Number(value);
  if (value.trim() === "" || !Number.isFinite(amount)) {
    throw new TypeError(`${name} is not a valid numeric value: "${value}"`);
  }
  return amount;
}

/** Converts `numeric` string columns to the shape `calculateCostUsd` expects. */
export function toTokenPricing(row: PricingRow): TokenPricing {
  return {
    inputPerMTokUsd: parseUsd("inputPerMTokUsd", row.inputPerMTokUsd),
    outputPerMTokUsd: parseUsd("outputPerMTokUsd", row.outputPerMTokUsd),
    cachedInputPerMTokUsd:
      row.cachedInputPerMTokUsd === null
        ? null
        : parseUsd("cachedInputPerMTokUsd", row.cachedInputPerMTokUsd),
  };
}
