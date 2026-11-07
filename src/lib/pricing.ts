import type { TokenPricing } from "./cost";

/** The fields of a `model_pricing` row needed to pick and apply a price. */
export interface PricingRow {
  effectiveFrom: Date;
  effectiveTo: Date | null;
  inputPerMTokUsd: string;
  outputPerMTokUsd: string;
  cachedInputPerMTokUsd: string | null;
  cacheWritePerMTokUsd: string | null;
  cacheWrite1hPerMTokUsd: string | null;
  longContextThresholdTokens: number | null;
  longInputPerMTokUsd: string | null;
  longOutputPerMTokUsd: string | null;
  longCachedInputPerMTokUsd: string | null;
  longCacheWritePerMTokUsd: string | null;
  longCacheWrite1hPerMTokUsd: string | null;
  batchMultiplier: string | null;
  webSearchPer1kUsd: string | null;
  audioInputPerMTokUsd: string | null;
  cachedAudioInputPerMTokUsd: string | null;
  audioOutputPerMTokUsd: string | null;
  imageInputPerMTokUsd: string | null;
  cachedImageInputPerMTokUsd: string | null;
  imageOutputPerMTokUsd: string | null;
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

const optionalUsd = (name: string, value: string | null) =>
  value === null ? null : parseUsd(name, value);

/** Converts `numeric` string columns to the shape `calculateCostUsd` expects. */
export function toTokenPricing(row: PricingRow): TokenPricing {
  const pricing: TokenPricing = {
    inputPerMTokUsd: parseUsd("inputPerMTokUsd", row.inputPerMTokUsd),
    outputPerMTokUsd: parseUsd("outputPerMTokUsd", row.outputPerMTokUsd),
    cachedInputPerMTokUsd: optionalUsd(
      "cachedInputPerMTokUsd",
      row.cachedInputPerMTokUsd,
    ),
    cacheWritePerMTokUsd: optionalUsd(
      "cacheWritePerMTokUsd",
      row.cacheWritePerMTokUsd,
    ),
    cacheWrite1hPerMTokUsd: optionalUsd(
      "cacheWrite1hPerMTokUsd",
      row.cacheWrite1hPerMTokUsd,
    ),
    batchMultiplier: optionalUsd("batchMultiplier", row.batchMultiplier),
    longContext: null,
    audio: null,
    image: null,
  };

  if (
    row.imageInputPerMTokUsd !== null ||
    row.cachedImageInputPerMTokUsd !== null ||
    row.imageOutputPerMTokUsd !== null
  ) {
    // Each image rate is optional, falling back to its text rate.
    pricing.image = {
      inputPerMTokUsd: optionalUsd(
        "imageInputPerMTokUsd",
        row.imageInputPerMTokUsd,
      ),
      cachedInputPerMTokUsd: optionalUsd(
        "cachedImageInputPerMTokUsd",
        row.cachedImageInputPerMTokUsd,
      ),
      outputPerMTokUsd: optionalUsd(
        "imageOutputPerMTokUsd",
        row.imageOutputPerMTokUsd,
      ),
    };
  }

  if (row.audioInputPerMTokUsd !== null) {
    // The database requires an audio output rate with an input rate.
    if (row.audioOutputPerMTokUsd === null) {
      throw new TypeError("An audio input rate needs an audio output rate");
    }
    pricing.audio = {
      inputPerMTokUsd: parseUsd(
        "audioInputPerMTokUsd",
        row.audioInputPerMTokUsd,
      ),
      cachedInputPerMTokUsd: optionalUsd(
        "cachedAudioInputPerMTokUsd",
        row.cachedAudioInputPerMTokUsd,
      ),
      outputPerMTokUsd: parseUsd(
        "audioOutputPerMTokUsd",
        row.audioOutputPerMTokUsd,
      ),
    };
  }

  if (row.longContextThresholdTokens !== null) {
    // The database requires long input and output rates with a threshold.
    if (row.longInputPerMTokUsd === null || row.longOutputPerMTokUsd === null) {
      throw new TypeError(
        "A long-context threshold needs long input and output rates",
      );
    }
    pricing.longContext = {
      thresholdTokens: row.longContextThresholdTokens,
      inputPerMTokUsd: parseUsd("longInputPerMTokUsd", row.longInputPerMTokUsd),
      outputPerMTokUsd: parseUsd(
        "longOutputPerMTokUsd",
        row.longOutputPerMTokUsd,
      ),
      cachedInputPerMTokUsd: optionalUsd(
        "longCachedInputPerMTokUsd",
        row.longCachedInputPerMTokUsd,
      ),
      cacheWritePerMTokUsd: optionalUsd(
        "longCacheWritePerMTokUsd",
        row.longCacheWritePerMTokUsd,
      ),
      cacheWrite1hPerMTokUsd: optionalUsd(
        "longCacheWrite1hPerMTokUsd",
        row.longCacheWrite1hPerMTokUsd,
      ),
    };
  }
  return pricing;
}

/**
 * The price rows a usage tier is billed from: flex and fast have their
 * own; standard and batch use the standard row (batch at its multiplier).
 */
export function priceTierFor(
  serviceTier: "standard" | "batch" | "flex" | "fast" | undefined,
): "standard" | "flex" | "fast" {
  return serviceTier === "flex" || serviceTier === "fast"
    ? serviceTier
    : "standard";
}
