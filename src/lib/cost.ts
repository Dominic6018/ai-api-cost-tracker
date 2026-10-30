/** Token counts for a single request. */
export interface TokenUsage {
  /** All input tokens, including cached and cache-write tokens. */
  inputTokens: number;
  outputTokens: number;
  /** Portion of inputTokens read from the provider's prompt cache. */
  cachedInputTokens?: number;
  /** Portion of inputTokens written to the provider's prompt cache. */
  cacheWriteInputTokens?: number;
}

/** One set of prices in USD per 1M tokens. */
export interface TokenRates {
  inputPerMTokUsd: number;
  outputPerMTokUsd: number;
  /** Falls back to the input price when the model has no cache discount. */
  cachedInputPerMTokUsd?: number | null;
  /** Falls back to the input price when cache writes aren't charged extra. */
  cacheWritePerMTokUsd?: number | null;
}

/** A model's prices, optionally with higher rates for long prompts. */
export interface TokenPricing extends TokenRates {
  /**
   * Rates for the whole request when its input tokens exceed
   * `thresholdTokens`. Long-tier cached and cache-write rates fall back
   * to the long input rate.
   */
  longContext?: (TokenRates & { thresholdTokens: number }) | null;
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
 */
export function calculateCostUsd(
  usage: TokenUsage,
  pricing: TokenPricing,
): number {
  const cached = usage.cachedInputTokens ?? 0;
  const writes = usage.cacheWriteInputTokens ?? 0;
  assertCount("inputTokens", usage.inputTokens);
  assertCount("outputTokens", usage.outputTokens);
  assertCount("cachedInputTokens", cached);
  assertCount("cacheWriteInputTokens", writes);
  if (cached + writes > usage.inputTokens) {
    throw new RangeError(
      `cachedInputTokens (${cached}) plus cacheWriteInputTokens (${writes}) cannot exceed inputTokens (${usage.inputTokens})`,
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
  assertPrice("inputPerMTokUsd", inputRate);
  assertPrice("outputPerMTokUsd", rates.outputPerMTokUsd);
  assertPrice("cachedInputPerMTokUsd", cachedRate);
  assertPrice("cacheWritePerMTokUsd", writeRate);

  const raw =
    ((usage.inputTokens - cached - writes) * inputRate +
      cached * cachedRate +
      writes * writeRate +
      usage.outputTokens * rates.outputPerMTokUsd) /
    TOKENS_PER_MILLION;

  return Number(raw.toFixed(USD_DECIMALS));
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
