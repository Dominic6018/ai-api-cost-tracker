/**
 * Why spend changed between two periods, split into effects that add up
 * exactly to the change:
 *
 * - volume: more or fewer requests, at the earlier period's mix and cost;
 * - model mix: requests moving between models, and models that started
 *   or stopped being used;
 * - tokens per request: longer or shorter requests on the same model;
 * - then what's left on the same model, its cost per token, split by
 *   repricing the tokens at the price table's rates into the
 *   input/output mix, the cache rate (the share of input read from or
 *   written to the cache) and price changes, with "other" for what the
 *   rates don't model: long-prompt tiers, batch, audio, images, web
 *   searches, a price change during a period, and rounding.
 *
 * Each step swaps one driver from the earlier period to the later one
 * (a chained substitution), so the order is part of the method, and is
 * stated wherever the result is shown. Amounts are micro-dollars; each
 * step is rounded half up once, and the effects are differences between
 * steps, so they always add up to the change exactly.
 */

import { calculateCostMicros, type TokenPricing } from "./cost";

export const COMPARISONS = ["30d", "7d", "month"] as const;
export type Comparison = (typeof COMPARISONS)[number];
export const DEFAULT_COMPARISON: Comparison = "30d";

export const COMPARISON_LABELS: Record<Comparison, string> = {
  "30d": "Last 30 days vs the 30 before",
  "7d": "Last 7 days vs the 7 before",
  month: "Last month vs the month before",
};

export function parseComparison(value: unknown): Comparison {
  const text = Array.isArray(value) ? value[0] : value;
  return COMPARISONS.includes(text as Comparison)
    ? (text as Comparison)
    : DEFAULT_COMPARISON;
}

export interface Period {
  /** Inclusive. */
  from: Date;
  /** Exclusive. */
  to: Date;
}

const DAY = 86_400_000;

/**
 * The two periods compared, in whole UTC days so neither is partial:
 * today is left out, and "month" compares the last two finished months.
 */
export function comparisonPeriods(
  now: Date,
  comparison: Comparison,
): { before: Period; after: Period } {
  const today = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  if (comparison === "month") {
    const y = now.getUTCFullYear();
    const m = now.getUTCMonth();
    const start = (offset: number) => new Date(Date.UTC(y, m + offset, 1));
    return {
      before: { from: start(-2), to: start(-1) },
      after: { from: start(-1), to: start(0) },
    };
  }
  const days = comparison === "7d" ? 7 : 30;
  return {
    before: {
      from: new Date(today - 2 * days * DAY),
      to: new Date(today - days * DAY),
    },
    after: { from: new Date(today - days * DAY), to: new Date(today) },
  };
}

/** One model's priced usage in a period. */
export interface ModelUsage {
  requests: bigint;
  /** Input (including cached and cache writes) plus output tokens. */
  tokens: bigint;
  costMicros: bigint;
  /** The tokens by kind, to split the cost per token; optional. */
  parts?: TokenParts;
}

/** Tokens by how they're priced; `input` includes the other input kinds. */
export interface TokenParts {
  input: bigint;
  cached: bigint;
  /** Cache writes, including `writes1h`. */
  writes: bigint;
  writes1h: bigint;
  output: bigint;
}

/** A model's rates at the end of each period, from the price table. */
export interface ReferencePrices {
  before: TokenPricing | null;
  after: TokenPricing | null;
}

export interface ModelInput {
  provider: string;
  model: string;
  before: ModelUsage | null;
  after: ModelUsage | null;
}

export const EFFECTS = [
  "volume",
  "modelMix",
  "tokensPerRequest",
  "inputOutputMix",
  "cacheRate",
  "price",
  "other",
] as const;
export type Effect = (typeof EFFECTS)[number];
export type Effects = Record<Effect, bigint>;

export interface ModelChange extends ModelInput {
  changeMicros: bigint;
  effects: Effects;
}

export interface SpendChange {
  beforeMicros: bigint;
  afterMicros: bigint;
  changeMicros: bigint;
  beforeRequests: bigint;
  afterRequests: bigint;
  effects: Effects;
  /** Largest change first, either way. */
  models: ModelChange[];
}

/**
 * The cost of tokens at a model's plain rates: no long-prompt tier,
 * batch, audio or image rates, which depend on single requests.
 */
function atRates(parts: TokenParts, pricing: TokenPricing): bigint {
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

/** `later`'s input and output, with `earlier`'s mix of input kinds. */
function withInputMixOf(later: TokenParts, earlier: TokenParts): TokenParts {
  if (earlier.input === 0n) return later;
  const share = (n: bigint) => (later.input * n) / earlier.input;
  const writes = share(earlier.writes);
  return {
    input: later.input,
    cached: share(earlier.cached),
    writes,
    writes1h: writes === 0n ? 0n : share(earlier.writes1h),
    output: later.output,
  };
}

/**
 * Splits a model's change in cost per token (`later` cost less `step3`,
 * the later tokens at the earlier cost per token) by repricing at the
 * price table's rates: the input/output mix, then the cache rate, then
 * the price. What the rates don't explain is "other", so the parts add
 * up exactly. Without token kinds or prices for both periods, all of it
 * is other.
 */
function splitCostPerToken(
  a: ModelUsage,
  b: ModelUsage,
  step3: bigint,
  prices: ReferencePrices | undefined,
): Pick<Effects, "inputOutputMix" | "cacheRate" | "price" | "other"> {
  const total = b.costMicros - step3;
  const none = { inputOutputMix: 0n, cacheRate: 0n, price: 0n, other: total };
  if (
    !a.parts ||
    !b.parts ||
    !prices?.before ||
    !prices.after ||
    a.tokens === 0n
  ) {
    return none;
  }
  try {
    // The earlier tokens at the earlier rates, scaled to the later count.
    const x0 = scale(atRates(a.parts, prices.before), b.tokens, a.tokens);
    const x1 = atRates(withInputMixOf(b.parts, a.parts), prices.before);
    const x2 = atRates(b.parts, prices.before);
    const x3 = atRates(b.parts, prices.after);
    return {
      inputOutputMix: x1 - x0,
      cacheRate: x2 - x1,
      price: x3 - x2,
      other: total - (x3 - x0),
    };
  } catch {
    // Token counts the rates can't price (e.g. beyond a safe integer).
    return none;
  }
}

/** a × b ÷ c, rounded half up; all non-negative, c > 0. */
function scale(a: bigint, b: bigint, c: bigint): bigint {
  return (a * b * 2n + c) / (2n * c);
}

const abs = (n: bigint) => (n < 0n ? -n : n);

export function explainSpendChange(
  inputs: ModelInput[],
  /** By `provider/model`; without them, cost per token is all "other". */
  prices: Map<string, ReferencePrices> = new Map(),
): SpendChange {
  const total = (
    pick: (m: ModelInput) => ModelUsage | null,
    key: "requests" | "tokens" | "costMicros",
  ) => inputs.reduce((sum, m) => sum + (pick(m)?.[key] ?? 0n), 0n);
  const beforeRequests = total((m) => m.before, "requests");
  const afterRequests = total((m) => m.after, "requests");

  const models = inputs.map((m): ModelChange => {
    const a = m.before ?? { requests: 0n, tokens: 0n, costMicros: 0n };
    const b = m.after ?? { requests: 0n, tokens: 0n, costMicros: 0n };
    // With no earlier usage at all, every cost is new volume.
    const allNew = beforeRequests === 0n;
    const known = a.requests > 0n;
    // Step 1: the earlier cost, scaled to the later number of requests.
    const step1 = allNew
      ? b.costMicros
      : scale(a.costMicros, afterRequests, beforeRequests);
    // Step 2: the later requests on this model, at its earlier cost per
    // request. A model new in the later period costs what it cost.
    const step2 =
      allNew || !known
        ? b.costMicros
        : scale(b.requests, a.costMicros, a.requests);
    // Step 3: the later tokens, at the earlier cost per token (a model
    // with no earlier tokens keeps its cost per request).
    const step3 =
      allNew || !known || a.tokens === 0n
        ? step2
        : scale(b.tokens, a.costMicros, a.tokens);
    // Step 4 is the later cost itself.
    return {
      ...m,
      changeMicros: b.costMicros - a.costMicros,
      effects: {
        volume: step1 - a.costMicros,
        modelMix: step2 - step1,
        tokensPerRequest: step3 - step2,
        ...(allNew || !known
          ? {
              inputOutputMix: 0n,
              cacheRate: 0n,
              price: 0n,
              other: b.costMicros - step3,
            }
          : splitCostPerToken(
              a,
              b,
              step3,
              prices.get(`${m.provider}/${m.model}`),
            )),
      },
    };
  });

  const effects = Object.fromEntries(
    EFFECTS.map((e) => [e, models.reduce((sum, m) => sum + m.effects[e], 0n)]),
  ) as Effects;
  const beforeMicros = total((m) => m.before, "costMicros");
  const afterMicros = total((m) => m.after, "costMicros");
  return {
    beforeMicros,
    afterMicros,
    changeMicros: afterMicros - beforeMicros,
    beforeRequests,
    afterRequests,
    effects,
    models: models.sort((x, y) => {
      const d = abs(y.changeMicros) - abs(x.changeMicros);
      return d !== 0n
        ? d > 0n
          ? 1
          : -1
        : `${x.provider}/${x.model}`.localeCompare(`${y.provider}/${y.model}`);
    }),
  };
}
