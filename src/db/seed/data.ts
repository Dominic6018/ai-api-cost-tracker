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
// Start dates before the check date aren't recorded, so prices apply from
// the day they were checked. Usage before then has no price.
const CHECKED_ON = "2026-10-28";
const FROM = `${CHECKED_ON}T00:00:00Z`;

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
    source: GOOGLE,
    checkedOn: CHECKED_ON,
  },
];
