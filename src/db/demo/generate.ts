import { budgetStatus, budgetUtilization, toMicros } from "@/lib/budget";
import { calculateCostUsd, type TokenPricing } from "@/lib/cost";
import { selectEffectivePricing, type PricingRow } from "@/lib/pricing";
import type { Provider } from "../schema";
import { seedPrices, type SeedPrice } from "../seed/data";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Every demo project's slug starts with this, so demo data is easy to find and remove. */
export const DEMO_SLUG_PREFIX = "demo-";
/** Every demo event's request id starts with this. */
export const DEMO_REQUEST_PREFIX = "demo-";

interface ModelMix {
  provider: Provider;
  model: string;
  weight: number;
}

interface ProjectProfile {
  slug: string;
  name: string;
  /** Requests on an average weekday at the start of the period. */
  requestsPerDay: number;
  /** Daily growth over the period, e.g. 0.004 is +0.4% a day. */
  growthPerDay: number;
  /** Weekend volume as a share of weekday volume. */
  weekendFactor: number;
  models: ModelMix[];
  /** Typical prompt size, in input tokens. */
  inputTokens: number;
  /** Share of input read from the prompt cache. */
  cacheReadShare: number;
  /** Share of input written to the prompt cache. */
  cacheWriteShare: number;
  /** Output tokens as a share of input tokens. */
  outputShare: number;
  /** Chance a request is a long prompt (over a model's tier threshold). */
  longPromptChance: number;
  /** Budget state this project should land in for the current month. */
  budget: { usedShare: number } | null;
}

/**
 * Four projects telling one story each: a support bot nearing its budget,
 * a research agent over it (with a runaway-loop spike), a checkout
 * assistant comfortably within it, and batch jobs with no budget at all.
 */
export const DEMO_PROFILES: readonly ProjectProfile[] = [
  {
    slug: "demo-support-bot",
    name: "Support Bot",
    requestsPerDay: 40,
    growthPerDay: 0.004,
    weekendFactor: 0.45,
    models: [
      { provider: "anthropic", model: "claude-sonnet-5-5", weight: 3 },
      { provider: "anthropic", model: "claude-haiku-5-5", weight: 5 },
    ],
    inputTokens: 6_000,
    cacheReadShare: 0.6,
    cacheWriteShare: 0.08,
    outputShare: 0.12,
    longPromptChance: 0.04,
    budget: { usedShare: 0.88 },
  },
  {
    slug: "demo-research-agent",
    name: "Research Agent",
    requestsPerDay: 14,
    growthPerDay: 0.008,
    weekendFactor: 0.7,
    models: [
      { provider: "google", model: "gemini-2.5-pro", weight: 3 },
      { provider: "anthropic", model: "claude-opus-5-5", weight: 1 },
    ],
    inputTokens: 40_000,
    cacheReadShare: 0.3,
    cacheWriteShare: 0.05,
    outputShare: 0.05,
    longPromptChance: 0.2,
    budget: { usedShare: 1.3 },
  },
  {
    slug: "demo-checkout-assistant",
    name: "Checkout Assistant",
    requestsPerDay: 60,
    growthPerDay: 0.002,
    weekendFactor: 1.3,
    models: [
      { provider: "openai", model: "gpt-5.4-mini", weight: 6 },
      { provider: "openai", model: "gpt-4.1", weight: 1 },
    ],
    inputTokens: 1_500,
    cacheReadShare: 0.4,
    cacheWriteShare: 0,
    outputShare: 0.3,
    longPromptChance: 0,
    budget: { usedShare: 0.42 },
  },
  {
    slug: "demo-batch-summaries",
    name: "Batch Summaries",
    requestsPerDay: 25,
    growthPerDay: 0,
    weekendFactor: 1,
    models: [
      { provider: "google", model: "gemini-3.5-flash-lite", weight: 4 },
      { provider: "anthropic", model: "claude-haiku-5-5", weight: 1 },
    ],
    inputTokens: 12_000,
    cacheReadShare: 0,
    cacheWriteShare: 0,
    outputShare: 0.08,
    longPromptChance: 0.02,
    budget: null,
  },
];

export interface DemoEvent {
  projectSlug: string;
  provider: Provider;
  model: string;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  costUsd: string;
  requestId: string;
  occurredAt: Date;
}

export interface DemoProject {
  slug: string;
  name: string;
  monthlyBudgetUsd: string | null;
}

export interface DemoData {
  projects: DemoProject[];
  events: DemoEvent[];
}

/** Small, fast, seedable PRNG (mulberry32), so a seed always gives the same data. */
export function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function seedPricing(price: SeedPrice): PricingRow {
  const long = price.longContext;
  return {
    effectiveFrom: new Date(price.effectiveFrom),
    effectiveTo: price.effectiveTo ? new Date(price.effectiveTo) : null,
    inputPerMTokUsd: price.inputPerMTokUsd,
    outputPerMTokUsd: price.outputPerMTokUsd,
    cachedInputPerMTokUsd: price.cachedInputPerMTokUsd,
    cacheWritePerMTokUsd: price.cacheWritePerMTokUsd ?? null,
    longContextThresholdTokens: long?.thresholdTokens ?? null,
    longInputPerMTokUsd: long?.inputPerMTokUsd ?? null,
    longOutputPerMTokUsd: long?.outputPerMTokUsd ?? null,
    longCachedInputPerMTokUsd: long?.cachedInputPerMTokUsd ?? null,
    longCacheWritePerMTokUsd: long?.cacheWritePerMTokUsd ?? null,
  };
}

/**
 * The seeded price in effect at `at` for a model. Demo history reaches back
 * before the seed prices' start date, so every event uses today's price.
 */
function currentPricing(
  model: ModelMix,
  at: Date,
): TokenPricing & {
  threshold: number | null;
} {
  const rows = seedPrices
    .filter((p) => p.provider === model.provider && p.model === model.model)
    .map(seedPricing);
  const result = selectEffectivePricing(rows, at);
  if (!result.found) {
    throw new Error(`No seed price for ${model.provider}/${model.model}`);
  }
  return {
    ...result.pricing,
    threshold: result.row.longContextThresholdTokens,
  };
}

function pick<T extends { weight: number }>(items: readonly T[], r: number): T {
  const total = items.reduce((sum, item) => sum + item.weight, 0);
  let target = r * total;
  for (const item of items) {
    target -= item.weight;
    if (target < 0) return item;
  }
  return items[items.length - 1];
}

/** Spread around a typical value: 0.4x to ~2.5x, skewed like real prompts. */
const spread = (r: number) => 0.4 + 2.1 * r * r;

const isWeekend = (date: Date) => [0, 6].includes(date.getUTCDay());

/**
 * Builds deterministic demo data ending at `now`. The same `seed` and `now`
 * always produce the same projects, events and budgets. Budgets are set
 * from each project's spend this month, so the intended states (nearing,
 * over, within, no budget) hold whenever the data is generated.
 */
export function generateDemoData({
  now,
  days = 90,
  seed = 2026,
}: {
  now: Date;
  days?: number;
  seed?: number;
}): DemoData {
  const random = createRandom(seed);
  const today = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const events: DemoEvent[] = [];
  const projects: DemoProject[] = [];

  for (const profile of DEMO_PROFILES) {
    const pricing = new Map(
      profile.models.map((m) => [m.model, currentPricing(m, now)]),
    );
    let sequence = 0;
    let monthSpendMicros = 0n;
    // A runaway agent loop two weeks ago, for the research agent only.
    const spikeDay = profile.slug === "demo-research-agent" ? 14 : -1;

    for (let back = days - 1; back >= 0; back--) {
      const dayStart = today - back * DAY_MS;
      const date = new Date(dayStart);
      const elapsed = days - 1 - back;
      let volume =
        profile.requestsPerDay *
        (1 + profile.growthPerDay * elapsed) *
        (isWeekend(date) ? profile.weekendFactor : 1) *
        (0.85 + 0.3 * random());
      if (back === spikeDay) volume *= 4;
      // Today only has the hours that have passed.
      const dayEnd = back === 0 ? now.getTime() : dayStart + DAY_MS;
      const count = Math.round(volume * ((dayEnd - dayStart) / DAY_MS));

      for (let i = 0; i < count; i++) {
        const mix = pick(profile.models, random());
        const price = pricing.get(mix.model)!;
        const long =
          price.threshold !== null && random() < profile.longPromptChance;
        const inputTokens = long
          ? price.threshold! + 1 + Math.floor(random() * price.threshold! * 0.8)
          : Math.max(50, Math.round(profile.inputTokens * spread(random())));
        const cachedInputTokens = Math.floor(
          inputTokens * profile.cacheReadShare * random(),
        );
        const cacheWriteInputTokens = Math.min(
          inputTokens - cachedInputTokens,
          Math.floor(inputTokens * profile.cacheWriteShare * random()),
        );
        const outputTokens = Math.max(
          1,
          Math.round(inputTokens * profile.outputShare * spread(random())),
        );
        const occurredAt = new Date(
          dayStart + Math.floor(random() * (dayEnd - dayStart)),
        );
        const usage = {
          inputTokens,
          cachedInputTokens,
          cacheWriteInputTokens,
          outputTokens,
        };
        const costUsd = calculateCostUsd(usage, price).toFixed(6);
        if (occurredAt.getTime() >= monthStart) {
          monthSpendMicros += toMicros(costUsd);
        }
        events.push({
          projectSlug: profile.slug,
          provider: mix.provider,
          model: mix.model,
          ...usage,
          costUsd,
          requestId: `${DEMO_REQUEST_PREFIX}${profile.slug.slice(DEMO_SLUG_PREFIX.length)}-${String(++sequence).padStart(6, "0")}`,
          occurredAt,
        });
      }
    }

    projects.push({
      slug: profile.slug,
      name: profile.name,
      monthlyBudgetUsd: profile.budget
        ? budgetForShare(monthSpendMicros, profile.budget.usedShare)
        : null,
    });
  }

  events.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  return { projects, events };
}

/**
 * A budget (2 decimals, as the column stores it) at which `spent` is about
 * `usedShare` of the budget. Rounded so the intended budget state holds.
 */
export function budgetForShare(spentMicros: bigint, usedShare: number): string {
  const cents = Number(spentMicros) / 10_000 / usedShare;
  const rounded =
    usedShare >= 1 ? Math.floor(cents) : Math.max(1, Math.ceil(cents));
  return (Math.max(1, rounded) / 100).toFixed(2);
}

/** The budget state each demo project lands in, for checks and tests. */
export function demoBudgetStates(data: DemoData, now: Date) {
  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  return Object.fromEntries(
    data.projects.map((project) => {
      const spent = data.events
        .filter(
          (e) =>
            e.projectSlug === project.slug &&
            e.occurredAt.getTime() >= monthStart,
        )
        .reduce((sum, e) => sum + toMicros(e.costUsd), 0n);
      const usd = (Number(spent) / 1_000_000).toFixed(6);
      return [
        project.slug,
        budgetStatus(budgetUtilization(usd, project.monthlyBudgetUsd)),
      ];
    }),
  );
}
