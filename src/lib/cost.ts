/** Token counts for a single request. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  /** Portion of inputTokens served from the provider's prompt cache. */
  cachedInputTokens?: number;
}

/** Prices in USD per 1M tokens. */
export interface TokenPricing {
  inputPerMTokUsd: number;
  outputPerMTokUsd: number;
  /** Falls back to the input price when the model has no cache discount. */
  cachedInputPerMTokUsd?: number | null;
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
 * Computes the USD cost of a request, rounded to 6 decimal places to match
 * the `cost_usd` column precision. Cached input tokens are billed at the
 * cached rate and are not double-counted at the full input rate.
 */
export function calculateCostUsd(
  usage: TokenUsage,
  pricing: TokenPricing,
): number {
  const cached = usage.cachedInputTokens ?? 0;
  assertCount("inputTokens", usage.inputTokens);
  assertCount("outputTokens", usage.outputTokens);
  assertCount("cachedInputTokens", cached);
  if (cached > usage.inputTokens) {
    throw new RangeError(
      `cachedInputTokens (${cached}) cannot exceed inputTokens (${usage.inputTokens})`,
    );
  }

  const cachedRate = pricing.cachedInputPerMTokUsd ?? pricing.inputPerMTokUsd;
  assertPrice("inputPerMTokUsd", pricing.inputPerMTokUsd);
  assertPrice("outputPerMTokUsd", pricing.outputPerMTokUsd);
  assertPrice("cachedInputPerMTokUsd", cachedRate);

  const raw =
    ((usage.inputTokens - cached) * pricing.inputPerMTokUsd +
      cached * cachedRate +
      usage.outputTokens * pricing.outputPerMTokUsd) /
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
