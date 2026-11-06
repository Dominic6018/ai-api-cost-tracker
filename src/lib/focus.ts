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
] as const;
type TokenType = (typeof TOKEN_TYPES)[number]["key"];

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
  /** "batch" usage is listed at the batch price. */
  serviceTier: "standard" | "batch";
  outputTokens: number;
  requestId: string | null;
  customerId: string | null;
  userId: string | null;
  feature: string | null;
  runId: string | null;
  tags: Record<string, string> | null;
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
  return {
    long,
    rates: {
      input,
      "cached-input":
        (long
          ? pricing.longCachedInputPerMTokUsd
          : pricing.cachedInputPerMTokUsd) ?? input,
      "cache-write": cacheWrite,
      // As in calculateCostUsd: 1-hour writes fall back to the write rate.
      "cache-write-1h":
        (long
          ? pricing.longCacheWrite1hPerMTokUsd
          : pricing.cacheWrite1hPerMTokUsd) ?? cacheWrite,
      output: long ? pricing.longOutputPerMTokUsd! : pricing.outputPerMTokUsd,
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
 * the price in effect when it occurred. Token types with no tokens get no
 * row.
 */
export function focusRows(
  usage: FocusUsage,
  pricing: FocusPricing,
): FocusRow[] {
  const provider = PROVIDERS[usage.provider];
  const { long, rates } = ratesFor(pricing, usage.inputTokens);
  const tokens: Record<TokenType, number> = {
    input:
      usage.inputTokens - usage.cachedInputTokens - usage.cacheWriteInputTokens,
    "cached-input": usage.cachedInputTokens,
    "cache-write": usage.cacheWriteInputTokens - usage.cacheWrite1hInputTokens,
    "cache-write-1h": usage.cacheWrite1hInputTokens,
    output: usage.outputTokens,
  };
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

  return TOKEN_TYPES.filter(({ key }) => tokens[key] > 0).map(
    ({ key, meter }) => {
      const rate = unitPrice(rates[key]);
      const count = BigInt(tokens[key]);
      return {
        // Not the invoicing party: FOCUS requires 0 here (see above).
        BilledCost: "0",
        EffectiveCost: "0",
        // The estimate: ListUnitPrice × PricingQuantity, exactly.
        ListCost: formatDecimal({
          units: rate.units * count,
          scale: rate.scale + MILLION_SCALE,
        }),
        // No negotiated rate is known, so ContractedUnitPrice is left out
        // and ContractedCost equals BilledCost, as FOCUS requires.
        ContractedCost: "0",
        ListUnitPrice: formatDecimal(rate),
        PricingQuantity: formatDecimal({ units: count, scale: MILLION_SCALE }),
        PricingUnit: "1000000 Tokens",
        PricingCategory: "Standard",
        ConsumedQuantity: String(tokens[key]),
        ConsumedUnit: "Tokens",
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
        ChargeDescription: `${usage.model} ${meter.toLowerCase()}${batch ? " (batch)" : ""}`,
        InvoiceIssuerName: provider.name,
        ServiceProviderName: provider.name,
        HostProviderName: provider.name,
        ServiceName: provider.service,
        ServiceCategory: "AI and Machine Learning",
        ServiceSubcategory: "Generative AI",
        SkuId: `${usage.provider}/${usage.model}/${key}`,
        // One price per SKU: the stored price, its long-prompt tier, and
        // the batch price.
        SkuPriceId: `${pricing.id}/${key}${long ? "/long-prompt" : ""}${batch ? "/batch" : ""}`,
        SkuMeter: meter,
        SubAccountId: usage.projectId,
        SubAccountName: usage.projectName,
        SubAccountType: "Project",
        Tags: tags(usage),
        x_UsageEventId: usage.id,
        x_RequestId: usage.requestId,
      };
    },
  );
}
