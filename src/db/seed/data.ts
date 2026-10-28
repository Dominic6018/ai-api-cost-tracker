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

// The schema stores one rate per model, so only models with a single flat
// rate are seeded. Models priced by prompt length (OpenAI flagships above
// 272K tokens, Gemini 2.5/3.1 Pro above 200K, Claude Haiku 5.5 above 100K)
// are left out until tiered pricing is supported.
//
// Start dates before the check date aren't recorded, so prices apply from
// the day they were checked. Usage before then has no price.
const CHECKED_ON = "2026-10-28";
const FROM = `${CHECKED_ON}T00:00:00Z`;

export const seedPrices: SeedPrice[] = [
  // Anthropic: flat pricing across the full context window.
  // Cached input is the "Cache hits and refreshes" rate.
  {
    provider: "anthropic",
    model: "claude-fable-5-1",
    inputPerMTokUsd: "10",
    outputPerMTokUsd: "50",
    cachedInputPerMTokUsd: "0.25",
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
];
