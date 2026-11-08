/**
 * Usage as FOCUS 1.4 Cost and Usage rows (https://focus.finops.org).
 *
 * The tracker estimates cost from token counts and isn't the invoicing
 * provider, so the export is strictly compliant: BilledCost and
 * EffectiveCost are 0, as FOCUS requires for data not from the invoicing
 * party, and the estimate is ListCost = ListUnitPrice × PricingQuantity.
 * A FinOps tool can then merge it with the provider's own bill without
 * counting the spend twice.
 */

import type { Provider } from "@/db/schema";
import type { PricingRow } from "./pricing";

export const FOCUS_VERSION = "1.4";

/** Columns in output order: FOCUS columns first, then custom `x_` ones. */
export const FOCUS_COLUMNS = [
  "BilledCost",
  "EffectiveCost",
  "ListCost",
  "ContractedCost",
  "ListUnitPrice",
  "PricingQuantity",
  "PricingUnit",
  "PricingCategory",
  "ConsumedQuantity",
  "ConsumedUnit",
  "BillingCurrency",
  "BillingAccountId",
  "BillingAccountName",
  "BillingPeriodStart",
  "BillingPeriodEnd",
  "ChargePeriodStart",
  "ChargePeriodEnd",
  "ChargeCategory",
  "ChargeClass",
  "ChargeFrequency",
  "ChargeDescription",
  "InvoiceIssuerName",
  "ServiceProviderName",
  "HostProviderName",
  "ServiceName",
  "ServiceCategory",
  "ServiceSubcategory",
  "SkuId",
  "SkuPriceId",
  "SkuMeter",
  "SubAccountId",
  "SubAccountName",
  "SubAccountType",
  "Tags",
  "x_UsageEventId",
  "x_RequestId",
] as const;

export type FocusColumn = (typeof FOCUS_COLUMNS)[number];
export type FocusRow = Record<FocusColumn, string | null>;

const PROVIDERS: Record<Provider, { name: string; service: string }> = {
  anthropic: { name: "Anthropic", service: "Claude API" },
  openai: { name: "OpenAI", service: "OpenAI API" },
  google: { name: "Google", service: "Gemini API" },
  mistral: { name: "Mistral AI", service: "Mistral API" },
  other: { name: "Other", service: "AI API" },
};

export const TOKEN_TYPES = [
  { key: "input", meter: "Input Tokens" },
  { key: "cached-input", meter: "Cached Input Tokens" },
  { key: "cache-write", meter: "Cache Write Input Tokens" },
  { key: "cache-write-1h", meter: "1-Hour Cache Write Input Tokens" },
  { key: "output", meter: "Output Tokens" },
  { key: "audio-input", meter: "Audio Input Tokens" },
  { key: "cached-audio-input", meter: "Cached Audio Input Tokens" },
  { key: "audio-output", meter: "Audio Output Tokens" },
  { key: "image-input", meter: "Image Input Tokens" },
  { key: "cached-image-input", meter: "Cached Image Input Tokens" },
  { key: "image-output", meter: "Image Output Tokens" },
] as const;
type TokenType = (typeof TOKEN_TYPES)[number]["key"];

/** OpenAI's longer-lived cache writes last 12 hours, not one. */
const OPENAI_LONGER_WRITE = {
  sku: "cache-write-12h",
  meter: "12-Hour Cache Write Input Tokens",
};

/**
 * The tracker never sees the provider's billing account, which FOCUS
 * requires; these placeholders say so instead of inventing one.
 */
export const UNKNOWN_BILLING_ACCOUNT = {
  id: "unknown",
  name: "Unknown (not known to the cost tracker)",
};

/** A usage event with what its FOCUS rows need. */
export interface FocusUsage {
  id: string;
  occurredAt: Date;
  projectId: string;
  projectName: string;
  provider: Provider;
  model: string;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  /** The part of cacheWriteInputTokens written with a 1-hour TTL. */
  cacheWrite1hInputTokens: number;
  /**
   * "batch" usage is listed at the standard row's batch price; "flex" and
   * "fast" usage at their own rows' rates.
   */
  serviceTier: "standard" | "batch" | "flex" | "fast";
  outputTokens: number;
  requestId: string | null;
  customerId: string | null;
  userId: string | null;
  feature: string | null;
  runId: string | null;
  tags: Record<string, string> | null;
  /** Server-side web searches, listed as their own row. */
  webSearchRequests: number;
  /** Audio tokens, part of the input, cached input and output counts. */
  audioInputTokens: number;
  cachedAudioInputTokens: number;
  audioOutputTokens: number;
  /** Image tokens, part of the same counts. */
  imageInputTokens: number;
  cachedImageInputTokens: number;
  imageOutputTokens: number;
}

/** A price row with its ID, which identifies the SKU price. */
export interface FocusPricing extends PricingRow {
  id: string;
}

/** An exact decimal: `units` / 10^`scale`. */
interface Decimal {
  units: bigint;
  scale: number;
}

function parseDecimal(text: string): Decimal {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (!match) throw new TypeError(`Not a decimal: "${text}"`);
  const fraction = match[2] ?? "";
  return { units: BigInt(match[1] + fraction), scale: fraction.length };
}

/** Plain decimal notation, trailing zeros dropped, as NumericFormat allows. */
export function formatDecimal({ units, scale }: Decimal): string {
  const digits = units.toString().padStart(scale + 1, "0");
  const whole = digits.slice(0, digits.length - scale);
  const fraction = digits.slice(digits.length - scale).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

const MILLION_SCALE = 6;
const THOUSAND_SCALE = 3;

/**
 * The per-million-token rate for each token type, as stored. Above the
 * long-prompt threshold every token uses the long rates; cached and
 * cache-write rates fall back to the input rate, as the cost code does.
 */
export function ratesFor(
  pricing: PricingRow,
  inputTokens: number,
): { long: boolean; rates: Record<TokenType, string> } {
  const long =
    pricing.longContextThresholdTokens !== null &&
    inputTokens > pricing.longContextThresholdTokens;
  const input = long ? pricing.longInputPerMTokUsd! : pricing.inputPerMTokUsd;
  const cacheWrite =
    (long ? pricing.longCacheWritePerMTokUsd : pricing.cacheWritePerMTokUsd) ??
    input;
  const cached =
    (long
      ? pricing.longCachedInputPerMTokUsd
      : pricing.cachedInputPerMTokUsd) ?? input;
  const output = long
    ? pricing.longOutputPerMTokUsd!
    : pricing.outputPerMTokUsd;
  return {
    long,
    rates: {
      input,
      "cached-input": cached,
      "cache-write": cacheWrite,
      // As in calculateCostUsd: 1-hour writes fall back to the write rate.
      "cache-write-1h":
        (long
          ? pricing.longCacheWrite1hPerMTokUsd
          : pricing.cacheWrite1hPerMTokUsd) ?? cacheWrite,
      output,
      // Audio rates don't change for long prompts. Without them a row
      // with audio tokens throws in focusRows; "0" is never listed.
      "audio-input": pricing.audioInputPerMTokUsd ?? "0",
      "cached-audio-input":
        pricing.cachedAudioInputPerMTokUsd ??
        pricing.audioInputPerMTokUsd ??
        "0",
      "audio-output": pricing.audioOutputPerMTokUsd ?? "0",
      // Image rates fall back to the text rates in effect, as in
      // calculateCostUsd.
      "image-input": pricing.imageInputPerMTokUsd ?? input,
      "cached-image-input":
        pricing.cachedImageInputPerMTokUsd ??
        pricing.imageInputPerMTokUsd ??
        cached,
      "image-output": pricing.imageOutputPerMTokUsd ?? output,
    },
  };
}

const iso = (date: Date) => date.toISOString().replace(/\.\d{3}Z$/, "Z");

/** The UTC hour and calendar month containing `at`, as [start, end). */
function periods(at: Date) {
  const hour = Date.UTC(
    at.getUTCFullYear(),
    at.getUTCMonth(),
    at.getUTCDate(),
    at.getUTCHours(),
  );
  return {
    chargeStart: iso(new Date(hour)),
    chargeEnd: iso(new Date(hour + 60 * 60 * 1000)),
    billingStart: iso(
      new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1)),
    ),
    billingEnd: iso(
      new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1)),
    ),
  };
}

/**
 * Attribution and free-form tags as one FOCUS key-value JSON object, or
 * null without any. Tag keys can't be attribution names, so none clash.
 */
function tags(usage: FocusUsage): string | null {
  const values = {
    ...usage.tags,
    customerId: usage.customerId,
    userId: usage.userId,
    feature: usage.feature,
    runId: usage.runId,
  };
  const set = Object.entries(values).filter(([, value]) => value !== null);
  return set.length > 0 ? JSON.stringify(Object.fromEntries(set)) : null;
}

/**
 * One FOCUS row per token type a usage event used, priced at `pricing`,
 * the price in effect when it occurred, plus a row for any web searches.
 * Token types with no tokens get no row.
 */
export function focusRows(
  usage: FocusUsage,
  pricing: FocusPricing,
): FocusRow[] {
  const provider = PROVIDERS[usage.provider];
  const { long, rates } = ratesFor(pricing, usage.inputTokens);
  const uncachedAudio = usage.audioInputTokens - usage.cachedAudioInputTokens;
  const uncachedImage = usage.imageInputTokens - usage.cachedImageInputTokens;
  if (
    (usage.audioInputTokens > 0 || usage.audioOutputTokens > 0) &&
    pricing.audioInputPerMTokUsd === null
  ) {
    throw new TypeError("Audio usage needs a price with audio rates");
  }
  const tokens: Record<TokenType, number> = {
    input:
      usage.inputTokens -
      usage.cachedInputTokens -
      usage.cacheWriteInputTokens -
      uncachedAudio -
      uncachedImage,
    "cached-input":
      usage.cachedInputTokens -
      usage.cachedAudioInputTokens -
      usage.cachedImageInputTokens,
    "cache-write": usage.cacheWriteInputTokens - usage.cacheWrite1hInputTokens,
    "cache-write-1h": usage.cacheWrite1hInputTokens,
    output:
      usage.outputTokens - usage.audioOutputTokens - usage.imageOutputTokens,
    "audio-input": uncachedAudio,
    "cached-audio-input": usage.cachedAudioInputTokens,
    "audio-output": usage.audioOutputTokens,
    "image-input": uncachedImage,
    "cached-image-input": usage.cachedImageInputTokens,
    "image-output": usage.imageOutputTokens,
  };
  // SKUs priced at their own rate, which the long-prompt tier doesn't
  // change; image tokens without one are priced at the text rates.
  const ownRate = new Set<TokenType>([
    "audio-input",
    "cached-audio-input",
    "audio-output",
    ...(pricing.imageInputPerMTokUsd !== null
      ? (["image-input"] as const)
      : []),
    ...(pricing.cachedImageInputPerMTokUsd !== null ||
    pricing.imageInputPerMTokUsd !== null
      ? (["cached-image-input"] as const)
      : []),
    ...(pricing.imageOutputPerMTokUsd !== null
      ? (["image-output"] as const)
      : []),
  ]);
  const { chargeStart, chargeEnd, billingStart, billingEnd } = periods(
    usage.occurredAt,
  );
  // Batch usage is listed at the batch price: each rate times the
  // multiplier, exactly, as the cost code charges it.
  const batch = usage.serviceTier === "batch";
  let multiplier: Decimal | null = null;
  if (batch) {
    if (pricing.batchMultiplier === null) {
      throw new TypeError("Batch usage needs a price with a batch multiplier");
    }
    multiplier = parseDecimal(pricing.batchMultiplier);
  }
  const unitPrice = (rate: string): Decimal => {
    const standard = parseDecimal(rate);
    return multiplier
      ? {
          units: standard.units * multiplier.units,
          scale: standard.scale + multiplier.scale,
        }
      : standard;
  };

  const tier =
    usage.serviceTier === "standard" ? "" : ` (${usage.serviceTier})`;
  type Varying =
    | "ListCost"
    | "ListUnitPrice"
    | "PricingQuantity"
    | "PricingUnit"
    | "ConsumedQuantity"
    | "ConsumedUnit"
    | "ChargeDescription"
    | "SkuId"
    | "SkuPriceId"
    | "SkuMeter";
  const row = (fields: Record<Varying, string>): FocusRow => {
    const all: FocusRow = {
      ...fields,
      // Not the invoicing party: FOCUS requires 0 here (see above).
      BilledCost: "0",
      EffectiveCost: "0",
      // No negotiated rate is known, so ContractedUnitPrice is left out
      // and ContractedCost equals BilledCost, as FOCUS requires.
      ContractedCost: "0",
      PricingCategory: "Standard",
      BillingCurrency: "USD",
      BillingAccountId: UNKNOWN_BILLING_ACCOUNT.id,
      BillingAccountName: UNKNOWN_BILLING_ACCOUNT.name,
      BillingPeriodStart: billingStart,
      BillingPeriodEnd: billingEnd,
      ChargePeriodStart: chargeStart,
      ChargePeriodEnd: chargeEnd,
      ChargeCategory: "Usage",
      // Only corrections to a closed billing period have a class.
      ChargeClass: null,
      ChargeFrequency: "Usage-Based",
      InvoiceIssuerName: provider.name,
      ServiceProviderName: provider.name,
      HostProviderName: provider.name,
      ServiceName: provider.service,
      ServiceCategory: "AI and Machine Learning",
      ServiceSubcategory: "Generative AI",
      SubAccountId: usage.projectId,
      SubAccountName: usage.projectName,
      SubAccountType: "Project",
      Tags: tags(usage),
      x_UsageEventId: usage.id,
      x_RequestId: usage.requestId,
    };
    // Columns in FOCUS_COLUMNS order.
    return Object.fromEntries(
      FOCUS_COLUMNS.map((column) => [column, all[column]]),
    ) as FocusRow;
  };

  const rows = TOKEN_TYPES.filter(({ key }) => tokens[key] > 0).map(
    ({ key, meter: tokenMeter }) => {
      const { sku, meter } =
        usage.provider === "openai" && key === "cache-write-1h"
          ? OPENAI_LONGER_WRITE
          : { sku: key, meter: tokenMeter };
      const rate = unitPrice(rates[key]);
      const count = BigInt(tokens[key]);
      return row({
        // The estimate: ListUnitPrice × PricingQuantity, exactly.
        ListCost: formatDecimal({
          units: rate.units * count,
          scale: rate.scale + MILLION_SCALE,
        }),
        ListUnitPrice: formatDecimal(rate),
        PricingQuantity: formatDecimal({ units: count, scale: MILLION_SCALE }),
        PricingUnit: "1000000 Tokens",
        ConsumedQuantity: String(tokens[key]),
        ConsumedUnit: "Tokens",
        ChargeDescription: `${usage.model} ${meter.toLowerCase()}${tier}`,
        SkuId: `${usage.provider}/${usage.model}/${sku}`,
        // One price per SKU: the stored price, its long-prompt tier, and
        // the batch price (audio and image rates have no long-prompt tier).
        SkuPriceId: `${pricing.id}/${sku}${long && !ownRate.has(key) ? "/long-prompt" : ""}${batch ? "/batch" : ""}`,
        SkuMeter: meter,
      });
    },
  );

  // Web searches are priced per 1,000, the same in every tier.
  if (usage.webSearchRequests > 0) {
    if (pricing.webSearchPer1kUsd === null) {
      throw new TypeError("Web search usage needs a web search price");
    }
    const rate = parseDecimal(pricing.webSearchPer1kUsd);
    const count = BigInt(usage.webSearchRequests);
    rows.push(
      row({
        ListCost: formatDecimal({
          units: rate.units * count,
          scale: rate.scale + THOUSAND_SCALE,
        }),
        ListUnitPrice: formatDecimal(rate),
        PricingQuantity: formatDecimal({ units: count, scale: THOUSAND_SCALE }),
        PricingUnit: "1000 Searches",
        ConsumedQuantity: String(usage.webSearchRequests),
        ConsumedUnit: "Requests",
        ChargeDescription: `${usage.model} web searches${tier}`,
        SkuId: `${usage.provider}/${usage.model}/web-search`,
        SkuPriceId: `${pricing.id}/web-search`,
        SkuMeter: "Web Searches",
      }),
    );
  }
  return rows;
}
