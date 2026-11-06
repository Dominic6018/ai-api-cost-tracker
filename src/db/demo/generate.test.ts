import { createHash } from "node:crypto";
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
  REPLIES_PER_RESOLVED_TICKET,
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
        cacheWrite1hPerMTokUsd: p.cacheWrite1hPerMTokUsd ?? null,
        longContextThresholdTokens: p.longContext?.thresholdTokens ?? null,
        longInputPerMTokUsd: p.longContext?.inputPerMTokUsd ?? null,
        longOutputPerMTokUsd: p.longContext?.outputPerMTokUsd ?? null,
        longCachedInputPerMTokUsd: p.longContext?.cachedInputPerMTokUsd ?? null,
        longCacheWritePerMTokUsd: p.longContext?.cacheWritePerMTokUsd ?? null,
        longCacheWrite1hPerMTokUsd:
          p.longContext?.cacheWrite1hPerMTokUsd ?? null,
        batchMultiplier: p.batchMultiplier ?? null,
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

describe("attribution", () => {
  const bySlug = (slug: string) =>
    data.events.filter((e) => e.projectSlug === slug);

  it("leaves every token count, cost and timestamp as before attribution", () => {
    // Fingerprint of the data generated before attribution was added, for
    // the same seed and time. Attribution has its own random stream.
    const core = data.events.map((e) => [
      e.projectSlug,
      e.provider,
      e.model,
      e.inputTokens,
      e.cachedInputTokens,
      e.cacheWriteInputTokens,
      e.outputTokens,
      e.costUsd,
      e.requestId,
      e.occurredAt.toISOString(),
    ]);
    expect(data.events).toHaveLength(13_727);
    expect(
      createHash("sha256").update(JSON.stringify(core)).digest("hex"),
    ).toBe("1186b1fe14ec255f2a3262add93c606343cc6acbe8ed37fe63c80466d99be606");
    expect(data.projects.map((p) => p.monthlyBudgetUsd)).toEqual([
      "15.04",
      "104.91",
      "21.25",
      null,
    ]);
  });

  it("gives each project its own mix, leaving some fields unset", () => {
    const fields = (slug: string) => {
      const events = bySlug(slug);
      return {
        customer: events.every((e) => e.customerId),
        user: events.every((e) => e.userId),
        feature: events.every((e) => e.feature),
        run: events.every((e) => e.runId),
        noCustomer: events.every((e) => e.customerId === undefined),
        noUser: events.every((e) => e.userId === undefined),
        noRun: events.every((e) => e.runId === undefined),
      };
    };
    expect(fields("demo-support-bot")).toMatchObject({
      customer: true,
      user: true,
      feature: true,
      noRun: true,
    });
    expect(fields("demo-research-agent")).toMatchObject({
      customer: true,
      feature: true,
      run: true,
      noUser: true,
    });
    // Consumer shoppers: users, but no customer accounts.
    expect(fields("demo-checkout-assistant")).toMatchObject({
      user: true,
      feature: true,
      noCustomer: true,
      noRun: true,
    });
    expect(fields("demo-batch-summaries")).toMatchObject({
      feature: true,
      noCustomer: true,
      noUser: true,
      noRun: true,
    });
  });

  it("weights customers towards a few large accounts", () => {
    const counts = new Map<string, number>();
    for (const e of bySlug("demo-support-bot")) {
      counts.set(e.customerId!, (counts.get(e.customerId!) ?? 0) + 1);
    }
    const ranked = [...counts.values()].sort((a, b) => b - a);
    expect(counts.size).toBe(8);
    expect(ranked[0]).toBeGreaterThan(ranked.at(-1)! * 4);
  });

  it("groups research requests into short runs, one customer each", () => {
    const runs = new Map<string, { size: number; customers: Set<string> }>();
    for (const e of bySlug("demo-research-agent")) {
      const run = runs.get(e.runId!) ?? { size: 0, customers: new Set() };
      run.size++;
      run.customers.add(e.customerId!);
      runs.set(e.runId!, run);
    }
    expect([...runs.values()].every((r) => r.customers.size === 1)).toBe(true);
    const sizes = [...runs.values()].map((r) => r.size).sort((a, b) => a - b);
    // All but the runaway run (and a day's last, shorter run) are 4-12.
    expect(sizes[Math.floor(sizes.length / 2)]).toBeGreaterThanOrEqual(4);
    expect(sizes.at(-2)).toBeLessThanOrEqual(12);
  });

  it("turns the spike into one runaway run that costs the most", () => {
    const cost = new Map<string, bigint>();
    const days = new Map<string, Set<string>>();
    for (const e of bySlug("demo-research-agent")) {
      cost.set(e.runId!, (cost.get(e.runId!) ?? 0n) + toMicros(e.costUsd));
      const day = e.occurredAt.toISOString().slice(0, 10);
      days.set(e.runId!, (days.get(e.runId!) ?? new Set()).add(day));
    }
    const [top, second] = [...cost].sort((a, b) =>
      b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0,
    );
    expect([...days.get(top[0])!]).toEqual(["2026-10-17"]);
    // About 2.5x the next most expensive run for this seed and day.
    expect(top[1]).toBeGreaterThan(second[1] * 2n);
  });
});

describe("demo outcomes", () => {
  it("resolves about one ticket per few replies, per customer and day", () => {
    const replies = data.events.filter(
      (e) => e.feature === "ticket-reply" && e.customerId,
    ).length;
    const resolved = data.outcomes.reduce((sum, o) => sum + o.count, 0);
    expect(data.outcomes.length).toBeGreaterThan(0);
    expect(data.outcomes.every((o) => o.name === "ticket_resolved")).toBe(true);
    // Each customer-day rounds down, so the total is at most replies / 3.
    expect(resolved).toBeLessThanOrEqual(replies / REPLIES_PER_RESOLVED_TICKET);
    expect(resolved).toBeGreaterThan(replies / REPLIES_PER_RESOLVED_TICKET / 2);
  });

  it("attributes each outcome to a Support Bot customer, never in the future", () => {
    const customers = new Set(
      data.events
        .filter((e) => e.projectSlug === "demo-support-bot")
        .map((e) => e.customerId),
    );
    for (const outcome of data.outcomes) {
      expect(outcome.projectSlug).toBe("demo-support-bot");
      expect(customers.has(outcome.customerId)).toBe(true);
      expect(outcome.count).toBeGreaterThan(0);
      expect(outcome.occurredAt.getTime()).toBeLessThanOrEqual(now.getTime());
    }
  });
});
