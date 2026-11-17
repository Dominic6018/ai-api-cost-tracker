/**
 * Savings estimates: what the same measured workload would have cost in
 * other ways, at the price table's rates. They're estimates, not
 * promises: they say nothing about whether a cheaper model is as good,
 * whether the work could wait for a batch, or how much of a prompt
 * repeats. Each states its assumption where it's shown.
 */

import { calculateCostMicros, type TokenPricing } from "./cost";
import type { TokenParts } from "./spend-change";

export interface Workload {
  provider: string;
  model: string;
  requests: bigint;
  /** Recorded cost, at the standard tier. */
  costMicros: bigint;
  parts: TokenParts;
}

export interface PriceOption {
  provider: string;
  model: string;
  pricing: TokenPricing;
}

export interface SavingsRow {
  provider: string;
  model: string;
  requests: bigint;
  costMicros: bigint;
  /** No price in effect now, so nothing could be estimated. */
  priced: boolean;
  /**
   * The saving had it all gone through the provider's Batch API: the
   * recorded cost less the model's batch price; null without one.
   */
  batch: { multiplier: number; savingMicros: bigint } | null;
  /**
   * The saving for each 10% of uncached input read from the prompt cache
   * instead, before the cost of writing to it; null without uncached
   * input or a cache discount.
   */
  cachingPer10Percent: bigint | null;
  /** The cheapest other model from the provider for these tokens, if cheaper. */
  alternative: {
    model: string;
    costMicros: bigint;
    savingMicros: bigint;
  } | null;
}

export interface SavingsReport {
  rows: SavingsRow[];
  costMicros: bigint;
  batchMicros: bigint;
  cachingPer10PercentMicros: bigint;
  alternativeMicros: bigint;
}

/**
 * These tokens at a model's plain rates: no long-prompt tier, batch,
 * audio or image rates, which depend on single requests.
 */
export function atRates(parts: TokenParts, pricing: TokenPricing): bigint {
  return calculateCostMicros(
    {
      inputTokens: Number(parts.input),
      outputTokens: Number(parts.output),
      cachedInputTokens: Number(parts.cached),
      cacheWriteInputTokens: Number(parts.writes),
      cacheWrite1hInputTokens: Number(parts.writes1h),
    },
    { ...pricing, longContext: null, batchMultiplier: null },
  );
}

const key = (o: { provider: string; model: string }) =>
  `${o.provider}/${o.model}`;

export function estimateSavings(
  workloads: Workload[],
  prices: PriceOption[],
): SavingsReport {
  const byModel = new Map(prices.map((p) => [key(p), p.pricing]));
  const rows = workloads.map((w): SavingsRow => {
    const pricing = byModel.get(key(w));
    const base = {
      provider: w.provider,
      model: w.model,
      requests: w.requests,
      costMicros: w.costMicros,
    };
    if (!pricing) {
      return {
        ...base,
        priced: false,
        batch: null,
        cachingPer10Percent: null,
        alternative: null,
      };
    }
    let current: bigint;
    try {
      current = atRates(w.parts, pricing);
    } catch {
      // Token counts the rates can't price (e.g. beyond a safe integer).
      return {
        ...base,
        priced: false,
        batch: null,
        cachingPer10Percent: null,
        alternative: null,
      };
    }

    // A batch price is the standard price times the multiplier, every
    // rate included, so it applies to the recorded cost directly.
    const multiplier = pricing.batchMultiplier ?? null;
    const batch =
      multiplier !== null && multiplier < 1
        ? {
            multiplier,
            savingMicros:
              w.costMicros -
              (w.costMicros * BigInt(Math.round(multiplier * 10_000))) /
                10_000n,
          }
        : null;

    const uncached = w.parts.input - w.parts.cached - w.parts.writes;
    const tenth = uncached / 10n;
    const cached =
      tenth > 0n
        ? current -
          atRates({ ...w.parts, cached: w.parts.cached + tenth }, pricing)
        : 0n;

    let alternative: SavingsRow["alternative"] = null;
    for (const option of prices) {
      if (option.provider !== w.provider || option.model === w.model) continue;
      let cost: bigint;
      try {
        cost = atRates(w.parts, option.pricing);
      } catch {
        continue;
      }
      const saving = current - cost;
      if (
        saving > 0n &&
        (alternative === null || saving > alternative.savingMicros)
      ) {
        alternative = {
          model: option.model,
          costMicros: cost,
          savingMicros: saving,
        };
      }
    }
    return {
      ...base,
      priced: true,
      batch,
      cachingPer10Percent: cached > 0n ? cached : null,
      alternative,
    };
  });
  rows.sort((a, b) =>
    b.costMicros === a.costMicros
      ? key(a).localeCompare(key(b))
      : b.costMicros > a.costMicros
        ? 1
        : -1,
  );
  const sum = (pick: (r: SavingsRow) => bigint | undefined | null) =>
    rows.reduce((total, r) => total + (pick(r) ?? 0n), 0n);
  return {
    rows,
    costMicros: sum((r) => r.costMicros),
    batchMicros: sum((r) => r.batch?.savingMicros),
    cachingPer10PercentMicros: sum((r) => r.cachingPer10Percent),
    alternativeMicros: sum((r) => r.alternative?.savingMicros),
  };
}
