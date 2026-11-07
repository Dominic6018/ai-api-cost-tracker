import type { NewProject, Provider } from "../schema";

/**
 * A model price taken from a provider's official pricing page.
 * Amounts are USD per 1M tokens, as decimal strings to match `numeric`.
 */
export interface SeedPrice {
  provider: Provider;
  model: string;
  inputPerMTokUsd: string;
  outputPerMTokUsd: string;
  /** Price for reading cached input; null when the provider lists none. */
  cachedInputPerMTokUsd: string | null;
  /** Price for writing to the prompt cache; omit when not charged extra. */
  cacheWritePerMTokUsd?: string;
  /** Price for 1-hour cache writes, where they cost more; omit otherwise. */
  cacheWrite1hPerMTokUsd?: string;
  /** Higher rates for prompts with more input tokens than the threshold. */
  longContext?: {
    thresholdTokens: number;
    inputPerMTokUsd: string;
    outputPerMTokUsd: string;
    cachedInputPerMTokUsd?: string;
    cacheWritePerMTokUsd?: string;
    cacheWrite1hPerMTokUsd?: string;
  };
  /**
   * Batch requests cost this share of the standard price (Anthropic's Batch
   * API: "0.5"); omit when batch pricing wasn't verified.
   */
  batchMultiplier?: string;
  /** Charged per 1,000 web searches (Anthropic: "10"); omit when not verified. */
  webSearchPer1kUsd?: string;
  /**
   * Audio tokens' rates (OpenAI's audio and realtime models); omit for
   * models without audio. Cached audio falls back to the audio input rate.
   */
  audio?: {
    inputPerMTokUsd: string;
    cachedInputPerMTokUsd?: string;
    outputPerMTokUsd: string;
  };
  /**
   * The processing tier these rates are for; omitted means standard. Flex
   * and fast are separate rows, at their own published rates.
   */
  serviceTier?: "flex" | "fast";
  /** ISO timestamp the price applies from (inclusive). */
  effectiveFrom: string;
  /** ISO timestamp the price stops applying (exclusive); omit if open-ended. */
  effectiveTo?: string;
  source: string;
  /** ISO date the price was checked against `source`. */
  checkedOn: string;
}

export const sampleProjects: NewProject[] = [
  { name: "Sample App", slug: "sample-app", monthlyBudgetUsd: "100.00" },
];

const ANTHROPIC = "https://platform.claude.com/docs/en/about-claude/pricing";
const OPENAI = "https://developers.openai.com/api/docs/pricing";
const GOOGLE = "https://ai.google.dev/gemini-api/docs/pricing";

// Models priced by prompt length carry a long-context tier. OpenAI's
// long-context (>272K) rates are rendered client-side on its pricing page
// and couldn't be verified from the page source, so its tiered flagships
// aren't seeded.
//
// Cache writes are Anthropic's "5m cache writes" rate; 1-hour writes have
// their own "1h cache writes" rate (2× input). The 1-hour rates were added
// on 2026-11-06, checked against the same page; the rows keep their
// original check date.
//
// Anthropic's Batch API costs 50% of every standard rate (cache rates
// included, per the same page, checked 2026-11-06): batchMultiplier 0.5.
// Other providers' batch prices weren't verified, so they aren't seeded
// and their batch usage is refused until a batch price is added.
//
// Anthropic charges $10 per 1,000 web searches on every Claude model, on
// top of tokens and in fast mode too, and not discounted for batch
// (checked 2026-11-07): webSearchPer1kUsd 10. Other providers search
// prices weren't verified, so their searches are refused until one is added.
//
// Start dates before the check date aren't recorded, so prices apply from
// the day they were checked. Usage before then has no price.
const CHECKED_ON = "2026-10-28";
const FROM = `${CHECKED_ON}T00:00:00Z`;

// The flex and fast tier rates at the end, OpenAI's audio models, and
// gemini-2.5-pro's routing to Gemini 3.8 Flash were checked on this day.
const TIERS_CHECKED_ON = "2026-11-07";
const TIERS_FROM = `${TIERS_CHECKED_ON}T00:00:00Z`;

// When Google starts routing gemini-2.5-pro to Gemini 3.8 Flash. The page
// gives no time zone, so midnight UTC is used, as for its other dates.
const GEMINI_25_PRO_ROUTED = "2026-12-01T00:00:00Z";

export const seedPrices: SeedPrice[] = [
  // Anthropic: flat pricing across the full context window, except Haiku
  // 5.5. Cached input is the "Cache hits and refreshes" rate; cache writes
  // are the "5m cache writes" rate.
  {
    provider: "anthropic",
    model: "claude-fable-5-1",
    inputPerMTokUsd: "10",
    outputPerMTokUsd: "50",
    cachedInputPerMTokUsd: "0.25",
    cacheWritePerMTokUsd: "12.50",
    cacheWrite1hPerMTokUsd: "20",
    batchMultiplier: "0.5",
    webSearchPer1kUsd: "10",
    effectiveFrom: FROM,
    source: ANTHROPIC,
    checkedOn: CHECKED_ON,
  },
  {
    provider: "anthropic",
    model: "claude-opus-5-5",
    inputPerMTokUsd: "4",
    outputPerMTokUsd: "20",
    cachedInputPerMTokUsd: "0.20",
    cacheWritePerMTokUsd: "5",
    cacheWrite1hPerMTokUsd: "8",
    batchMultiplier: "0.5",
    webSearchPer1kUsd: "10",
    effectiveFrom: FROM,
    source: ANTHROPIC,
    checkedOn: CHECKED_ON,
  },
  {
    provider: "anthropic",
    model: "claude-sonnet-5-5",
    inputPerMTokUsd: "2",
    outputPerMTokUsd: "10",
    cachedInputPerMTokUsd: "0.10",
    cacheWritePerMTokUsd: "2.50",
    cacheWrite1hPerMTokUsd: "4",
    batchMultiplier: "0.5",
    webSearchPer1kUsd: "10",
    effectiveFrom: FROM,
    source: ANTHROPIC,
    checkedOn: CHECKED_ON,
  },

  {
    // Prompts over 100,000 tokens (counting cache reads and writes) pay the
    // long rates for the whole request.
    provider: "anthropic",
    model: "claude-haiku-5-5",
    inputPerMTokUsd: "0.10",
    outputPerMTokUsd: "0.50",
    cachedInputPerMTokUsd: "0.01",
    cacheWritePerMTokUsd: "0.125",
    cacheWrite1hPerMTokUsd: "0.20",
    longContext: {
      thresholdTokens: 100_000,
      inputPerMTokUsd: "0.50",
      outputPerMTokUsd: "2.50",
      cachedInputPerMTokUsd: "0.05",
      cacheWritePerMTokUsd: "0.625",
      cacheWrite1hPerMTokUsd: "1",
    },
    batchMultiplier: "0.5",
    webSearchPer1kUsd: "10",
    effectiveFrom: FROM,
    source: ANTHROPIC,
    checkedOn: CHECKED_ON,
  },

  // OpenAI: Standard tier, models without a long-context tier.
  {
    provider: "openai",
    model: "gpt-5.4-mini",
    inputPerMTokUsd: "0.75",
    outputPerMTokUsd: "4.50",
    cachedInputPerMTokUsd: "0.075",
    effectiveFrom: FROM,
    source: OPENAI,
    checkedOn: CHECKED_ON,
  },
  {
    provider: "openai",
    model: "gpt-5.4-nano",
    inputPerMTokUsd: "0.20",
    outputPerMTokUsd: "1.25",
    cachedInputPerMTokUsd: "0.02",
    effectiveFrom: FROM,
    source: OPENAI,
    checkedOn: CHECKED_ON,
  },
  {
    provider: "openai",
    model: "gpt-4.1",
    inputPerMTokUsd: "2",
    outputPerMTokUsd: "8",
    cachedInputPerMTokUsd: "0.50",
    effectiveFrom: FROM,
    source: OPENAI,
    checkedOn: CHECKED_ON,
  },
  {
    provider: "openai",
    model: "gpt-4o-mini",
    inputPerMTokUsd: "0.15",
    outputPerMTokUsd: "0.60",
    cachedInputPerMTokUsd: "0.075",
    effectiveFrom: FROM,
    source: OPENAI,
    checkedOn: CHECKED_ON,
  },

  // OpenAI audio and realtime models: text and audio tokens at their own
  // rates ("Realtime and audio generation models", checked 2026-11-07). The
  // gpt-audio models list no cached rates.
  {
    provider: "openai",
    model: "gpt-audio",
    inputPerMTokUsd: "2.50",
    outputPerMTokUsd: "10",
    cachedInputPerMTokUsd: null,
    audio: { inputPerMTokUsd: "32", outputPerMTokUsd: "64" },
    effectiveFrom: TIERS_FROM,
    source: OPENAI,
    checkedOn: TIERS_CHECKED_ON,
  },
  {
    provider: "openai",
    model: "gpt-audio-mini",
    inputPerMTokUsd: "0.60",
    outputPerMTokUsd: "2.40",
    cachedInputPerMTokUsd: null,
    audio: { inputPerMTokUsd: "10", outputPerMTokUsd: "20" },
    effectiveFrom: TIERS_FROM,
    source: OPENAI,
    checkedOn: TIERS_CHECKED_ON,
  },
  {
    provider: "openai",
    model: "gpt-realtime-2.1",
    inputPerMTokUsd: "4",
    outputPerMTokUsd: "24",
    cachedInputPerMTokUsd: "0.40",
    audio: {
      inputPerMTokUsd: "32",
      cachedInputPerMTokUsd: "0.40",
      outputPerMTokUsd: "64",
    },
    effectiveFrom: TIERS_FROM,
    source: OPENAI,
    checkedOn: TIERS_CHECKED_ON,
  },
  {
    provider: "openai",
    model: "gpt-realtime-2.1-mini",
    inputPerMTokUsd: "0.60",
    outputPerMTokUsd: "2.40",
    cachedInputPerMTokUsd: "0.06",
    audio: {
      inputPerMTokUsd: "10",
      cachedInputPerMTokUsd: "0.30",
      outputPerMTokUsd: "20",
    },
    effectiveFrom: TIERS_FROM,
    source: OPENAI,
    checkedOn: TIERS_CHECKED_ON,
  },

  // Google: paid tier, Standard. Cached input is the context caching price;
  // the hourly cache storage fee isn't modelled. The page doesn't give a
  // time zone for its price change dates, so midnight UTC is used.
  {
    provider: "google",
    model: "gemini-3.8-flash",
    inputPerMTokUsd: "0.75",
    outputPerMTokUsd: "3.75",
    cachedInputPerMTokUsd: "0.075",
    effectiveFrom: FROM,
    effectiveTo: "2027-01-01T00:00:00Z",
    source: GOOGLE,
    checkedOn: CHECKED_ON,
  },
  {
    provider: "google",
    model: "gemini-3.8-flash",
    inputPerMTokUsd: "1.50",
    outputPerMTokUsd: "7.50",
    cachedInputPerMTokUsd: "0.15",
    effectiveFrom: "2027-01-01T00:00:00Z",
    source: GOOGLE,
    checkedOn: CHECKED_ON,
  },
  {
    provider: "google",
    model: "gemini-3.5-flash-lite",
    inputPerMTokUsd: "0.30",
    outputPerMTokUsd: "2.50",
    cachedInputPerMTokUsd: "0.03",
    effectiveFrom: FROM,
    source: GOOGLE,
    checkedOn: CHECKED_ON,
  },
  {
    // Prompts over 200K tokens pay the long rates. The hourly cache storage
    // fee isn't modelled.
    provider: "google",
    model: "gemini-2.5-pro",
    inputPerMTokUsd: "1.25",
    outputPerMTokUsd: "10",
    cachedInputPerMTokUsd: "0.125",
    longContext: {
      thresholdTokens: 200_000,
      inputPerMTokUsd: "2.50",
      outputPerMTokUsd: "15",
      cachedInputPerMTokUsd: "0.25",
    },
    effectiveFrom: FROM,
    // Deprecated: "Effective December 1, 2026, all API requests to
    // gemini-2.5-pro will automatically route to Gemini 3.8 Flash and be
    // billed at Gemini 3.8 Flash rates" (checked 2026-11-07).
    effectiveTo: GEMINI_25_PRO_ROUTED,
    source: GOOGLE,
    checkedOn: CHECKED_ON,
  },
  // From then on, Gemini 3.8 Flash's rates, which rise on 2027-01-01, with
  // no long-prompt tier.
  {
    provider: "google",
    model: "gemini-2.5-pro",
    inputPerMTokUsd: "0.75",
    outputPerMTokUsd: "3.75",
    cachedInputPerMTokUsd: "0.075",
    effectiveFrom: GEMINI_25_PRO_ROUTED,
    effectiveTo: "2027-01-01T00:00:00Z",
    source: GOOGLE,
    checkedOn: TIERS_CHECKED_ON,
  },
  {
    provider: "google",
    model: "gemini-2.5-pro",
    inputPerMTokUsd: "1.50",
    outputPerMTokUsd: "7.50",
    cachedInputPerMTokUsd: "0.15",
    effectiveFrom: "2027-01-01T00:00:00Z",
    source: GOOGLE,
    checkedOn: TIERS_CHECKED_ON,
  },

  // Processing tiers, each at its own published rates. They apply from the
  // day they were checked, like the rates above.
  //
  // OpenAI's "Flex" and "Fast" tables (short context; "Priority processing
  // was renamed Fast mode on July 30, 2026"). Only models seeded above and
  // listed in a table are included.
  {
    provider: "openai",
    model: "gpt-5.4-mini",
    serviceTier: "flex",
    inputPerMTokUsd: "0.375",
    outputPerMTokUsd: "2.25",
    cachedInputPerMTokUsd: "0.0375",
    effectiveFrom: TIERS_FROM,
    source: OPENAI,
    checkedOn: TIERS_CHECKED_ON,
  },
  {
    provider: "openai",
    model: "gpt-5.4-nano",
    serviceTier: "flex",
    inputPerMTokUsd: "0.10",
    outputPerMTokUsd: "0.625",
    cachedInputPerMTokUsd: "0.01",
    effectiveFrom: TIERS_FROM,
    source: OPENAI,
    checkedOn: TIERS_CHECKED_ON,
  },
  {
    provider: "openai",
    model: "gpt-5.4-mini",
    serviceTier: "fast",
    inputPerMTokUsd: "1.50",
    outputPerMTokUsd: "9.00",
    cachedInputPerMTokUsd: "0.15",
    effectiveFrom: TIERS_FROM,
    source: OPENAI,
    checkedOn: TIERS_CHECKED_ON,
  },
  {
    provider: "openai",
    model: "gpt-4.1",
    serviceTier: "fast",
    inputPerMTokUsd: "3.50",
    outputPerMTokUsd: "14.00",
    cachedInputPerMTokUsd: "0.875",
    effectiveFrom: TIERS_FROM,
    source: OPENAI,
    checkedOn: TIERS_CHECKED_ON,
  },
  {
    provider: "openai",
    model: "gpt-4o-mini",
    serviceTier: "fast",
    inputPerMTokUsd: "0.25",
    outputPerMTokUsd: "1.00",
    cachedInputPerMTokUsd: "0.125",
    effectiveFrom: TIERS_FROM,
    source: OPENAI,
    checkedOn: TIERS_CHECKED_ON,
  },

  // Anthropic fast mode: Claude Opus 5.5 at $8 input and $40 output, and
  // "Prompt caching multipliers apply on top of fast mode pricing": cache
  // reads at 0.05× input ($0.40), 5-minute writes at 1.25× ($10), 1-hour
  // writes at 2× ($16). Fast mode isn't available with the Batch API.
  {
    provider: "anthropic",
    model: "claude-opus-5-5",
    serviceTier: "fast",
    inputPerMTokUsd: "8",
    outputPerMTokUsd: "40",
    cachedInputPerMTokUsd: "0.40",
    cacheWritePerMTokUsd: "10",
    cacheWrite1hPerMTokUsd: "16",
    webSearchPer1kUsd: "10",
    effectiveFrom: TIERS_FROM,
    source: ANTHROPIC,
    checkedOn: TIERS_CHECKED_ON,
  },
];
