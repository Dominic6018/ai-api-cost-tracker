import { describe, expect, it } from "vitest";
import { toMicros } from "@/lib/budget";
import { calculateCostUsd } from "@/lib/cost";
import { toTokenPricing } from "@/lib/pricing";
import { usagePayloadSchema } from "@/lib/usage";
import { seedPrices } from "../seed/data";
import {
  budgetForShare,
  createRandom,
  DEMO_PROFILES,
  DEMO_REQUEST_PREFIX,
  DEMO_SLUG_PREFIX,
  demoBudgetStates,
  generateDemoData,
} from "./generate";

const now = new Date("2026-10-31T15:30:00Z");
const data = generateDemoData({ now });
const DAY_MS = 24 * 60 * 60 * 1000;

describe("createRandom", () => {
  it("repeats for the same seed and differs between seeds", () => {
    const a = createRandom(1);
    const b = createRandom(1);
    const c = createRandom(2);
    const first = [a(), a(), a()];
    expect([b(), b(), b()]).toEqual(first);
    expect([c(), c(), c()]).not.toEqual(first);
    expect(first.every((n) => n >= 0 && n < 1)).toBe(true);
  });
});

describe("generateDemoData", () => {
  it("is deterministic for the same seed and time", () => {
    expect(generateDemoData({ now })).toEqual(data);
    expect(generateDemoData({ now, seed: 7 })).not.toEqual(data);
  });

  it("creates the demo projects, all with the demo prefix", () => {
    expect(data.projects.map((p) => p.slug)).toEqual(
      DEMO_PROFILES.map((p) => p.slug),
    );
    for (const project of data.projects) {
      expect(project.slug.startsWith(DEMO_SLUG_PREFIX)).toBe(true);
    }
  });

  it("spans 90 days up to now, never in the future", () => {
    const times = data.events.map((e) => e.occurredAt.getTime());
    const firstDay = Date.UTC(2026, 9, 31) - 89 * DAY_MS;
    expect(Math.min(...times)).toBeGreaterThanOrEqual(firstDay);
    expect(Math.min(...times)).toBeLessThan(firstDay + DAY_MS);
    expect(Math.max(...times)).toBeLessThanOrEqual(now.getTime());
    const days = new Set(
      data.events.map((e) => e.occurredAt.toISOString().slice(0, 10)),
    );
    expect(days.size).toBe(90);
  });

  it("produces realistic volume and is sorted by time", () => {
    expect(data.events.length).toBeGreaterThan(8_000);
    expect(data.events.length).toBeLessThan(25_000);
    const times = data.events.map((e) => e.occurredAt.getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it("only uses seeded models", () => {
    const seeded = new Set(seedPrices.map((p) => `${p.provider}/${p.model}`));
    for (const event of data.events) {
      expect(seeded.has(`${event.provider}/${event.model}`)).toBe(true);
    }
  });

  it("passes the same validation as POST /api/usage", () => {
    for (const event of data.events) {
      const result = usagePayloadSchema.safeParse({
        provider: event.provider,
        model: event.model,
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        cachedInputTokens: event.cachedInputTokens,
        cacheWriteInputTokens: event.cacheWriteInputTokens,
        requestId: event.requestId,
        occurredAt: event.occurredAt.toISOString(),
      });
      expect(result.success).toBe(true);
    }
  });

  it("gives every event a unique demo request id and a positive cost", () => {
    const ids = data.events.map((e) => e.requestId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const event of data.events) {
      expect(event.requestId.startsWith(DEMO_REQUEST_PREFIX)).toBe(true);
      expect(toMicros(event.costUsd)).toBeGreaterThan(0n);
    }
  });

  it("prices every event with the current seed price, long tiers included", () => {
    // Rebuilt from the seed data directly, as the pricing lookup reads rows.
    const priceFor = (provider: string, model: string) => {
      const p = seedPrices.find(
        (s) =>
          s.provider === provider &&
          s.model === model &&
          (!s.effectiveTo || new Date(s.effectiveTo) > now),
      )!;
      return toTokenPricing({
        effectiveFrom: new Date(p.effectiveFrom),
        effectiveTo: null,
        inputPerMTokUsd: p.inputPerMTokUsd,
        outputPerMTokUsd: p.outputPerMTokUsd,
        cachedInputPerMTokUsd: p.cachedInputPerMTokUsd,
        cacheWritePerMTokUsd: p.cacheWritePerMTokUsd ?? null,
        longContextThresholdTokens: p.longContext?.thresholdTokens ?? null,
        longInputPerMTokUsd: p.longContext?.inputPerMTokUsd ?? null,
        longOutputPerMTokUsd: p.longContext?.outputPerMTokUsd ?? null,
        longCachedInputPerMTokUsd: p.longContext?.cachedInputPerMTokUsd ?? null,
        longCacheWritePerMTokUsd: p.longContext?.cacheWritePerMTokUsd ?? null,
      });
    };
    for (const event of data.events) {
      expect(event.costUsd).toBe(
        calculateCostUsd(event, priceFor(event.provider, event.model)).toFixed(
          6,
        ),
      );
    }
  });

  it("covers cached input, cache writes and long prompts", () => {
    expect(data.events.some((e) => e.cachedInputTokens > 0)).toBe(true);
    expect(data.events.some((e) => e.cacheWriteInputTokens > 0)).toBe(true);
    // Haiku 5.5's long tier starts above 100,000; Gemini 2.5 Pro's above 200,000.
    expect(
      data.events.some(
        (e) => e.model === "claude-haiku-5-5" && e.inputTokens > 100_000,
      ),
    ).toBe(true);
    expect(
      data.events.some(
        (e) => e.model === "gemini-2.5-pro" && e.inputTokens > 200_000,
      ),
    ).toBe(true);
  });

  it("includes a research agent spike two weeks ago", () => {
    const perDay = (slug: string) => {
      const counts = new Map<string, number>();
      for (const e of data.events.filter((e) => e.projectSlug === slug)) {
        const day = e.occurredAt.toISOString().slice(0, 10);
        counts.set(day, (counts.get(day) ?? 0) + 1);
      }
      return counts;
    };
    const research = perDay("demo-research-agent");
    const busiest = [...research.entries()].sort((a, b) => b[1] - a[1])[0];
    expect(busiest[0]).toBe("2026-10-17");
  });

  it("lands each project in its intended budget state", () => {
    expect(demoBudgetStates(data, now)).toEqual({
      "demo-support-bot": "warning",
      "demo-research-agent": "over",
      "demo-checkout-assistant": "ok",
      "demo-batch-summaries": "none",
    });
  });

  it.each([
    "2026-11-02T09:00:00Z",
    "2026-11-15T23:59:00Z",
    "2027-02-28T12:00:00Z",
  ])("keeps the intended budget states on %s", (iso) => {
    const at = new Date(iso);
    expect(
      Object.values(demoBudgetStates(generateDemoData({ now: at }), at)),
    ).toEqual(["warning", "over", "ok", "none"]);
  });
});

describe("budgetForShare", () => {
  it("rounds so the intended share holds", () => {
    // $88 spent at 88% -> $100.00 budget
    expect(budgetForShare(88_000_000n, 0.88)).toBe("100.00");
    // Over budget rounds the budget down, never above the spend
    expect(budgetForShare(130_000_001n, 1.3)).toBe("100.00");
    expect(budgetForShare(1n, 0.5)).toBe("0.01");
  });
});
