import "dotenv/config";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseEnv } from "@/lib/env";
import type { UsageInput } from "@/lib/usage";
import { modelPricing, projects, usageEvents } from "./schema";
import { recordUsage } from "./usage";

// Runs against the database in DATABASE_URL after `npm run db:migrate`.
const client = postgres(parseEnv().DATABASE_URL, {
  max: 1,
  onnotice: () => {},
});
const db = drizzle(client);

// Unique per run so tests never collide with seed or leftover rows.
const model = `it-usage-${randomUUID()}`;
const tieredModel = `it-usage-tiered-${randomUUID()}`;
const audioModel = `it-usage-audio-${randomUUID()}`;
const imageModel = `it-usage-image-${randomUUID()}`;
let projectId: string;
const pricingIds: string[] = [];

beforeAll(async () => {
  const [project] = await db
    .insert(projects)
    .values({ name: "Usage test", slug: `it-${randomUUID()}` })
    .returning();
  projectId = project.id;

  const prices = await db
    .insert(modelPricing)
    .values([
      {
        provider: "anthropic",
        model,
        inputPerMTokUsd: "3",
        outputPerMTokUsd: "15",
        cachedInputPerMTokUsd: "0.3",
        webSearchPer1kUsd: "10",
        effectiveFrom: new Date("2026-01-01T00:00:00Z"),
      },
      // The same model's fast tier, without a web search price, at its own (double) rates.
      {
        provider: "anthropic",
        model,
        serviceTier: "fast",
        inputPerMTokUsd: "6",
        outputPerMTokUsd: "30",
        cachedInputPerMTokUsd: "0.6",
        effectiveFrom: new Date("2026-01-01T00:00:00Z"),
      },
      // gpt-image-1.5's rates: image tokens above text.
      {
        provider: "openai",
        model: imageModel,
        inputPerMTokUsd: "5",
        outputPerMTokUsd: "10",
        cachedInputPerMTokUsd: "1.25",
        imageInputPerMTokUsd: "8",
        cachedImageInputPerMTokUsd: "2",
        imageOutputPerMTokUsd: "32",
        effectiveFrom: new Date("2026-01-01T00:00:00Z"),
      },
      // gpt-realtime-2.1's rates: audio far above text.
      {
        provider: "openai",
        model: audioModel,
        inputPerMTokUsd: "4",
        outputPerMTokUsd: "24",
        cachedInputPerMTokUsd: "0.4",
        audioInputPerMTokUsd: "32",
        cachedAudioInputPerMTokUsd: "0.4",
        audioOutputPerMTokUsd: "64",
        batchMultiplier: "0.5",
        effectiveFrom: new Date("2026-01-01T00:00:00Z"),
      },
      // Claude Haiku 5.5's rates: higher for prompts over 100,000 tokens.
      {
        provider: "anthropic",
        model: tieredModel,
        inputPerMTokUsd: "0.10",
        outputPerMTokUsd: "0.50",
        cachedInputPerMTokUsd: "0.01",
        cacheWritePerMTokUsd: "0.125",
        cacheWrite1hPerMTokUsd: "0.20",
        batchMultiplier: "0.5",
        longContextThresholdTokens: 100_000,
        longInputPerMTokUsd: "0.50",
        longOutputPerMTokUsd: "2.50",
        longCachedInputPerMTokUsd: "0.05",
        longCacheWritePerMTokUsd: "0.625",
        effectiveFrom: new Date("2026-01-01T00:00:00Z"),
      },
    ])
    .returning();
  pricingIds.push(...prices.map((p) => p.id));
});

afterAll(async () => {
  // Deleting the project cascades to its usage events.
  await db.delete(projects).where(eq(projects.id, projectId));
  await db.delete(modelPricing).where(inArray(modelPricing.id, pricingIds));
  await client.end();
});

/** Expects usage stored without a price, for the given reason. */
async function expectUnpriced(input: UsageInput, reason: string) {
  const result = await recordUsage(db, input);
  if (!result.ok) throw new Error(`expected it stored, got ${result.error}`);
  expect(result.replayed).toBe(false);
  expect(result.event).toMatchObject({
    costUsd: null,
    webSearchCostUsd: "0.000000",
    pricingStatus: "unpriced",
    unpricedReason: reason,
  });
  return result.event;
}

function usage(overrides: Partial<UsageInput> = {}): UsageInput {
  return {
    projectId,
    provider: "anthropic",
    model,
    inputTokens: 1_000_000,
    outputTokens: 100_000,
    cachedInputTokens: 400_000,
    cacheWriteInputTokens: 0,
    cacheWrite1hInputTokens: 0,
    serviceTier: "standard",
    webSearchRequests: 0,
    audioInputTokens: 0,
    cachedAudioInputTokens: 0,
    audioOutputTokens: 0,
    imageInputTokens: 0,
    cachedImageInputTokens: 0,
    imageOutputTokens: 0,
    occurredAt: new Date("2026-06-01T00:00:00Z"),
    ...overrides,
  };
}

describe("recordUsage", () => {
  it("prices and stores usage with the rate in effect", async () => {
    const result = await recordUsage(
      db,
      usage({ requestId: `req-${randomUUID()}`, metadata: { route: "/chat" } }),
    );
    if (!result.ok) throw new Error(`expected success, got ${result.error}`);

    // 600k uncached * $3 + 400k cached * $0.30 + 100k output * $15, per 1M
    expect(result.event.costUsd).toBe("3.420000");
    expect(result.event.metadata).toEqual({ route: "/chat" });

    const [stored] = await db
      .select()
      .from(usageEvents)
      .where(eq(usageEvents.id, result.event.id));
    expect(stored.costUsd).toBe("3.420000");
    expect(stored.occurredAt.toISOString()).toBe("2026-06-01T00:00:00.000Z");
  });

  it("charges web searches per 1,000 on top of tokens, and keeps them apart", async () => {
    const requestId = `req-search-${randomUUID()}`;
    const result = await recordUsage(
      db,
      usage({ requestId, webSearchRequests: 3 }),
    );
    if (!result.ok) throw new Error(`expected success, got ${result.error}`);
    // $3.42 of tokens + 3 searches at $10 per 1,000
    expect(result.event).toMatchObject({
      costUsd: "3.450000",
      webSearchRequests: 3,
      webSearchCostUsd: "0.030000",
    });
    // A retry with a different search count is a conflict, not a replay.
    expect(
      await recordUsage(db, usage({ requestId, webSearchRequests: 2 })),
    ).toEqual({ ok: false, error: "request_id_conflict" });
    expect(
      await recordUsage(db, usage({ requestId, webSearchRequests: 3 })),
    ).toMatchObject({ ok: true, replayed: true });
  });

  it("bills audio tokens at the audio rates, and replays only the same split", async () => {
    const requestId = `req-audio-${randomUUID()}`;
    const spoken = (overrides: Partial<UsageInput> = {}) =>
      usage({
        provider: "openai",
        model: audioModel,
        requestId,
        inputTokens: 4_500,
        cachedInputTokens: 1_500,
        audioInputTokens: 3_000,
        cachedAudioInputTokens: 1_000,
        outputTokens: 1_000,
        audioOutputTokens: 800,
        ...overrides,
      });
    const result = await recordUsage(db, spoken());
    if (!result.ok) throw new Error(`expected success, got ${result.error}`);
    // Text: 1,000 × $4 + 500 × $0.40 + 200 × $24; audio: 2,000 × $32
    // + 1,000 × $0.40 + 800 × $64, per 1M
    expect(result.event).toMatchObject({
      costUsd: "0.124600",
      audioInputTokens: 3_000,
      cachedAudioInputTokens: 1_000,
      audioOutputTokens: 800,
    });
    expect(await recordUsage(db, spoken({ audioOutputTokens: 700 }))).toEqual({
      ok: false,
      error: "request_id_conflict",
    });
    expect(await recordUsage(db, spoken())).toMatchObject({
      ok: true,
      replayed: true,
    });
    // Batch halves audio too.
    const batch = await recordUsage(
      db,
      spoken({ requestId: undefined, serviceTier: "batch" }),
    );
    expect(batch.ok && batch.event.costUsd).toBe("0.062300");
  });

  it("bills image tokens at the image rates, and replays only the same split", async () => {
    const requestId = `req-image-${randomUUID()}`;
    const imaged = (overrides: Partial<UsageInput> = {}) =>
      usage({
        provider: "openai",
        model: imageModel,
        requestId,
        inputTokens: 1_000,
        cachedInputTokens: 300,
        imageInputTokens: 800,
        cachedImageInputTokens: 200,
        outputTokens: 4_050,
        imageOutputTokens: 4_000,
        ...overrides,
      });
    const result = await recordUsage(db, imaged());
    if (!result.ok) throw new Error(`expected success, got ${result.error}`);
    // Text: 100 x $5 + 100 cached x $1.25 + 50 out x $10; image: 600 x $8
    // + 200 cached x $2 + 4,000 out x $32, per 1M
    expect(result.event).toMatchObject({
      costUsd: "0.134325",
      imageInputTokens: 800,
      cachedImageInputTokens: 200,
      imageOutputTokens: 4_000,
    });
    expect(await recordUsage(db, imaged({ imageOutputTokens: 3_999 }))).toEqual(
      {
        ok: false,
        error: "request_id_conflict",
      },
    );
  });

  it("bills image tokens as text when the price has no image rates", async () => {
    // Vision input: the same cost as without the split.
    const plain = await recordUsage(db, usage());
    const vision = await recordUsage(db, usage({ imageInputTokens: 500_000 }));
    expect(vision.ok && vision.event.costUsd).toBe(
      plain.ok && plain.event.costUsd,
    );
    expect(vision.ok && vision.event.imageInputTokens).toBe(500_000);
  });

  it("keeps audio usage unpriced when the price has no audio rates", async () => {
    await expectUnpriced(
      usage({
        inputTokens: 1_000_000,
        cachedInputTokens: 0,
        audioInputTokens: 10,
      }),
      "no_audio_pricing",
    );
    await expectUnpriced(usage({ audioOutputTokens: 1 }), "no_audio_pricing");
  });

  it("keeps web searches unpriced when the matching price has no rate", async () => {
    // The fast row and the tiered model have no web search price.
    for (const input of [
      usage({ serviceTier: "fast", webSearchRequests: 1 }),
      usage({ model: tieredModel, webSearchRequests: 1 }),
    ]) {
      await expectUnpriced(input, "no_web_search_pricing");
    }
    // Without searches the same usage is recorded, at no search cost.
    const plain = await recordUsage(db, usage({ model: tieredModel }));
    expect(plain.ok && plain.event.webSearchCostUsd).toBe("0.000000");
  });

  it("keeps usage from before the model's first price, unpriced", async () => {
    await expectUnpriced(
      usage({ occurredAt: new Date("2025-06-01T00:00:00Z") }),
      "no_pricing",
    );
  });

  it("keeps usage of an unknown model, unpriced, and replays it", async () => {
    const input = usage({
      model: `missing-${randomUUID()}`,
      requestId: `req-${randomUUID()}`,
    });
    const stored = await expectUnpriced(input, "no_pricing");
    const retry = await recordUsage(db, input);
    expect(retry.ok && retry.replayed && retry.event.id).toBe(stored.id);
  });

  it("returns project_not_found for an unknown project", async () => {
    expect(await recordUsage(db, usage({ projectId: randomUUID() }))).toEqual({
      ok: false,
      error: "project_not_found",
    });
  });
});

describe("recordUsage with tiered pricing and cache writes", () => {
  const tiered = (overrides: Partial<UsageInput>) =>
    usage({
      model: tieredModel,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 1_000_000,
      ...overrides,
    });

  it("prices a short prompt at the base rates, cache writes included", async () => {
    // 50k uncached * $0.10 + 30k writes * $0.125 + 20k cached * $0.01
    // + 1M out * $0.50, per 1M tokens
    const result = await recordUsage(
      db,
      tiered({
        inputTokens: 100_000,
        cacheWriteInputTokens: 30_000,
        cachedInputTokens: 20_000,
      }),
    );
    if (!result.ok) throw new Error(result.error);
    expect(result.event.costUsd).toBe("0.508950");
    expect(result.event.cacheWriteInputTokens).toBe(30_000);
  });

  it("prices batch usage at the batch multiplier, and replays only the same tier", async () => {
    // The same usage as the 1-hour test below costs $0.509700 at standard
    // prices; batch is half: $0.254850.
    const requestId = `req-batch-${randomUUID()}`;
    const batch = tiered({
      inputTokens: 100_000,
      cacheWriteInputTokens: 30_000,
      cacheWrite1hInputTokens: 10_000,
      cachedInputTokens: 20_000,
      serviceTier: "batch",
      requestId,
    });
    const result = await recordUsage(db, batch);
    if (!result.ok) throw new Error(result.error);
    expect(result.event).toMatchObject({
      costUsd: "0.254850",
      serviceTier: "batch",
    });

    expect(await recordUsage(db, batch)).toMatchObject({
      ok: true,
      replayed: true,
    });
    expect(
      await recordUsage(db, { ...batch, serviceTier: "standard" }),
    ).toEqual({ ok: false, error: "request_id_conflict" });
  });

  it("prices fast usage from the fast tier's own rates", async () => {
    // 600k uncached * $6 + 400k cached * $0.60 + 100k out * $30
    const fast = await recordUsage(db, usage({ serviceTier: "fast" }));
    if (!fast.ok) throw new Error(fast.error);
    expect(fast.event).toMatchObject({
      costUsd: "6.840000",
      serviceTier: "fast",
    });
    // The standard tier is unaffected: 600k * $3 + 400k * $0.30 + 100k * $15
    const standard = await recordUsage(db, usage());
    expect(standard.ok && standard.event.costUsd).toBe("3.420000");
  });

  it("keeps a tier without its own price unpriced, never billing it at standard", async () => {
    await expectUnpriced(usage({ serviceTier: "flex" }), "no_tier_pricing");
  });

  it("keeps batch usage unpriced for a model without a batch price", async () => {
    await expectUnpriced(usage({ serviceTier: "batch" }), "no_batch_pricing");
    // The same usage at standard prices is recorded.
    expect((await recordUsage(db, usage())).ok).toBe(true);
  });

  it("prices 1-hour cache writes at their rate, and replays only the same split", async () => {
    // 50k uncached * $0.10 + 20k 5-minute writes * $0.125
    // + 10k 1-hour writes * $0.20 + 20k cached * $0.01 + 1M out * $0.50
    const requestId = `req-1h-${randomUUID()}`;
    const split = tiered({
      inputTokens: 100_000,
      cacheWriteInputTokens: 30_000,
      cacheWrite1hInputTokens: 10_000,
      cachedInputTokens: 20_000,
      requestId,
    });
    const result = await recordUsage(db, split);
    if (!result.ok) throw new Error(result.error);
    expect(result.event.costUsd).toBe("0.509700");
    expect(result.event.cacheWrite1hInputTokens).toBe(10_000);

    expect(await recordUsage(db, split)).toMatchObject({
      ok: true,
      replayed: true,
    });
    expect(
      await recordUsage(db, { ...split, cacheWrite1hInputTokens: 0 }),
    ).toEqual({ ok: false, error: "request_id_conflict" });
  });

  it("prices a prompt over the threshold at the long rates", async () => {
    // 100k uncached * $0.50 + 100k writes * $0.625 + 1M out * $2.50
    const result = await recordUsage(
      db,
      tiered({ inputTokens: 200_000, cacheWriteInputTokens: 100_000 }),
    );
    if (!result.ok) throw new Error(result.error);
    expect(result.event.costUsd).toBe("2.612500");
  });
});

describe("recordUsage idempotency", () => {
  async function countEvents(requestId: string) {
    const rows = await db
      .select({ id: usageEvents.id })
      .from(usageEvents)
      .where(eq(usageEvents.requestId, requestId));
    return rows.length;
  }

  it("replays the stored event for a repeated request id", async () => {
    const requestId = `req-${randomUUID()}`;
    const first = await recordUsage(db, usage({ requestId }));
    const second = await recordUsage(db, usage({ requestId }));

    if (!first.ok || !second.ok) throw new Error("expected both to succeed");
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.event).toEqual(first.event);
    expect(await countEvents(requestId)).toBe(1);
  });

  it("stores attribution, and replays a retry whatever attribution it sends", async () => {
    const requestId = `req-${randomUUID()}`;
    const attribution = {
      customerId: "cus_42",
      userId: "u_7",
      feature: "support-chat",
      runId: `run-${randomUUID()}`,
    };
    const first = await recordUsage(db, usage({ requestId, ...attribution }));
    if (!first.ok) throw new Error(`expected success, got ${first.error}`);
    expect(first.event).toMatchObject(attribution);

    // Like metadata, attribution isn't part of what makes usage the same.
    const retry = await recordUsage(
      db,
      usage({ requestId, customerId: "someone-else" }),
    );
    if (!retry.ok) throw new Error(`expected replay, got ${retry.error}`);
    expect(retry.replayed).toBe(true);
    expect(retry.event.customerId).toBe("cus_42");
    expect(await countEvents(requestId)).toBe(1);
  });

  it("stores tags, and replays a retry whatever tags it sends", async () => {
    const requestId = `req-${randomUUID()}`;
    const first = await recordUsage(
      db,
      usage({ requestId, tags: { env: "prod", team: "search" } }),
    );
    if (!first.ok) throw new Error(`expected success, got ${first.error}`);
    expect(first.event.tags).toEqual({ env: "prod", team: "search" });
    const retry = await recordUsage(
      db,
      usage({ requestId, tags: { env: "dev" } }),
    );
    if (!retry.ok) throw new Error(`expected replay, got ${retry.error}`);
    expect(retry.replayed).toBe(true);
    expect(retry.event.tags).toEqual({ env: "prod", team: "search" });
  });

  it("replays even when occurredAt differs between attempts", async () => {
    const requestId = `req-${randomUUID()}`;
    await recordUsage(db, usage({ requestId }));
    const retry = await recordUsage(
      db,
      usage({ requestId, occurredAt: new Date("2026-06-01T00:05:00Z") }),
    );
    expect(retry.ok && retry.replayed).toBe(true);
    expect(await countEvents(requestId)).toBe(1);
  });

  it("treats different cache-write tokens as different usage", async () => {
    const requestId = `req-${randomUUID()}`;
    await recordUsage(db, usage({ requestId }));
    expect(
      await recordUsage(db, usage({ requestId, cacheWriteInputTokens: 1 })),
    ).toEqual({ ok: false, error: "request_id_conflict" });
  });

  it("returns request_id_conflict when the retry describes different usage", async () => {
    const requestId = `req-${randomUUID()}`;
    await recordUsage(db, usage({ requestId }));
    expect(
      await recordUsage(db, usage({ requestId, outputTokens: 1 })),
    ).toEqual({ ok: false, error: "request_id_conflict" });
    expect(await countEvents(requestId)).toBe(1);
  });

  it("keeps request ids apart between projects", async () => {
    const [other] = await db
      .insert(projects)
      .values({ name: "Other project", slug: `it-${randomUUID()}` })
      .returning();
    try {
      const requestId = `req-${randomUUID()}`;
      const mine = await recordUsage(db, usage({ requestId }));
      // Another project, which could be another organization's, records
      // its own event: it can neither be blocked nor learn that ours exists.
      const theirs = await recordUsage(
        db,
        usage({ requestId, projectId: other.id, outputTokens: 7 }),
      );
      if (!mine.ok || !theirs.ok) throw new Error("expected both to succeed");
      expect(theirs.replayed).toBe(false);
      expect(theirs.event.id).not.toBe(mine.event.id);
      expect(theirs.event.projectId).toBe(other.id);
      // Each project's retries still replay its own event.
      const retry = await recordUsage(
        db,
        usage({ requestId, projectId: other.id, outputTokens: 7 }),
      );
      expect(retry.ok && retry.replayed && retry.event.id).toBe(
        theirs.event.id,
      );
      expect(await countEvents(requestId)).toBe(2);
    } finally {
      await db.delete(projects).where(eq(projects.id, other.id));
    }
  });

  it("always inserts events without a request id", async () => {
    const first = await recordUsage(db, usage());
    const second = await recordUsage(db, usage());
    if (!first.ok || !second.ok) throw new Error("expected both to succeed");
    expect(first.replayed || second.replayed).toBe(false);
    expect(first.event.id).not.toBe(second.event.id);
  });

  it("stores one event when identical requests race", async () => {
    // A separate pool so the requests really run concurrently.
    const raceClient = postgres(parseEnv().DATABASE_URL, {
      max: 8,
      onnotice: () => {},
    });
    try {
      const raceDb = drizzle(raceClient);
      const requestId = `req-${randomUUID()}`;
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          recordUsage(raceDb, usage({ requestId })),
        ),
      );

      expect(results.every((r) => r.ok)).toBe(true);
      const inserted = results.filter((r) => r.ok && !r.replayed);
      expect(inserted).toHaveLength(1);
      const ids = new Set(results.map((r) => r.ok && r.event.id));
      expect(ids.size).toBe(1);
      expect(await countEvents(requestId)).toBe(1);
    } finally {
      await raceClient.end();
    }
  });
});
