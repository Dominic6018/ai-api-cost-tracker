import { toMicros } from "./budget";

/** Token counts for a single request. */
export interface TokenUsage {
  /** All input tokens, including cached and cache-write tokens. */
  inputTokens: number;
  outputTokens: number;
  /** Portion of inputTokens read from the provider's prompt cache. */
  cachedInputTokens?: number;
  /** Portion of inputTokens written to the provider's prompt cache. */
  cacheWriteInputTokens?: number;
  /**
   * Portion of cacheWriteInputTokens written with a 1-hour TTL (Anthropic
   * bills these at 2× input, against 1.25× for 5-minute writes).
   */
  cacheWrite1hInputTokens?: number;
  /**
   * Defaults to standard. "batch" applies the batch multiplier; "flex" and
   * "fast" are priced from their own rows, so pass their pricing.
   */
  serviceTier?: "standard" | "batch" | "flex" | "fast";
}

/** One set of prices in USD per 1M tokens. */
export interface TokenRates {
  inputPerMTokUsd: number;
  outputPerMTokUsd: number;
  /** Falls back to the input price when the model has no cache discount. */
  cachedInputPerMTokUsd?: number | null;
  /** Falls back to the input price when cache writes aren't charged extra. */
  cacheWritePerMTokUsd?: number | null;
  /** 1-hour cache writes; falls back to the (5-minute) cache-write price. */
  cacheWrite1hPerMTokUsd?: number | null;
}

/** A model's prices, optionally with higher rates for long prompts. */
export interface TokenPricing extends TokenRates {
  /**
   * Rates for the whole request when its input tokens exceed
   * `thresholdTokens`. Long-tier cached and cache-write rates fall back
   * to the long input rate.
   */
  longContext?: (TokenRates & { thresholdTokens: number }) | null;
  /**
   * Batch requests cost this share of the standard price, every rate and
   * tier included (Anthropic: 0.5). Null when batch isn't priced.
   */
  batchMultiplier?: number | null;
}

const TOKENS_PER_MILLION = 1_000_000;
const USD_DECIMALS = 6;

function assertCount(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(
      `${name} must be a non-negative integer, got ${value}`,
    );
  }
}

function assertPrice(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative number, got ${value}`);
  }
}

/**
 * The rates that apply to a request. A prompt longer than the model's
 * threshold pays the long rates for every token, as providers bill it;
 * "longer" means strictly more input tokens than the threshold.
 */
export function ratesForUsage(
  usage: Pick<TokenUsage, "inputTokens">,
  pricing: TokenPricing,
): TokenRates {
  const long = pricing.longContext;
  if (long && usage.inputTokens > long.thresholdTokens) return long;
  return pricing;
}

/**
 * Computes the USD cost of a request, rounded to 6 decimal places to match
 * the `cost_usd` column precision. Cached and cache-write input tokens are
 * billed at their own rates and not double-counted at the input rate.
 * Batch usage costs the standard price times the model's batch multiplier;
 * it throws when the model has none, which callers check first.
 */
export function calculateCostUsd(
  usage: TokenUsage,
  pricing: TokenPricing,
): number {
  const cached = usage.cachedInputTokens ?? 0;
  const writes = usage.cacheWriteInputTokens ?? 0;
  const writes1h = usage.cacheWrite1hInputTokens ?? 0;
  assertCount("inputTokens", usage.inputTokens);
  assertCount("outputTokens", usage.outputTokens);
  assertCount("cachedInputTokens", cached);
  assertCount("cacheWriteInputTokens", writes);
  assertCount("cacheWrite1hInputTokens", writes1h);
  if (cached + writes > usage.inputTokens) {
    throw new RangeError(
      `cachedInputTokens (${cached}) plus cacheWriteInputTokens (${writes}) cannot exceed inputTokens (${usage.inputTokens})`,
    );
  }
  if (writes1h > writes) {
    throw new RangeError(
      `cacheWrite1hInputTokens (${writes1h}) cannot exceed cacheWriteInputTokens (${writes})`,
    );
  }
  if (pricing.longContext) {
    assertCount(
      "longContext.thresholdTokens",
      pricing.longContext.thresholdTokens,
    );
  }

  const rates = ratesForUsage(usage, pricing);
  const inputRate = rates.inputPerMTokUsd;
  const cachedRate = rates.cachedInputPerMTokUsd ?? inputRate;
  const writeRate = rates.cacheWritePerMTokUsd ?? inputRate;
  const write1hRate = rates.cacheWrite1hPerMTokUsd ?? writeRate;
  assertPrice("inputPerMTokUsd", inputRate);
  assertPrice("outputPerMTokUsd", rates.outputPerMTokUsd);
  assertPrice("cachedInputPerMTokUsd", cachedRate);
  assertPrice("cacheWritePerMTokUsd", writeRate);
  assertPrice("cacheWrite1hPerMTokUsd", write1hRate);

  const standard =
    ((usage.inputTokens - cached - writes) * inputRate +
      cached * cachedRate +
      (writes - writes1h) * writeRate +
      writes1h * write1hRate +
      usage.outputTokens * rates.outputPerMTokUsd) /
    TOKENS_PER_MILLION;

  if (usage.serviceTier !== "batch") {
    return Number(standard.toFixed(USD_DECIMALS));
  }

  // The batch discount applies to the whole request, before rounding.
  const multiplier = pricing.batchMultiplier;
  if (multiplier === null || multiplier === undefined) {
    throw new RangeError("No batch price is configured for this model");
  }
  if (!(multiplier > 0 && multiplier <= 1)) {
    throw new RangeError(
      `batchMultiplier must be in (0, 1], got ${multiplier}`,
    );
  }
  // Halving often lands exactly on half a micro-dollar, where float noise
  // (427.4999… instead of 427.5) would decide the rounding. Drop the noise,
  // then round half up, as the exact FOCUS export does.
  const micros = Number((standard * multiplier * 1e6).toFixed(6));
  return Math.round(micros) / 1e6;
}

const usdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});

/** Formats a USD amount for display, e.g. `$12.3456`. */
export function formatUsd(amount: number): string {
  return usdFormatter.format(amount);
}

/**
 * The exact cost of web searches, in micro-dollars: searches × the price
 * per 1,000 ÷ 1,000, rounded half up. Charged on top of tokens, and not
 * discounted with them (Anthropic: $10 per 1,000, so $0.01 a search).
 */
export function webSearchCostMicros(
  searches: number,
  per1kUsd: string,
): bigint {
  assertCount("webSearchRequests", searches);
  const perThousand = toMicros(per1kUsd);
  return (BigInt(searches) * perThousand + 500n) / 1000n;
}
