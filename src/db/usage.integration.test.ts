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
let projectId: string;
let pricingId: string;

beforeAll(async () => {
  const [project] = await db
    .insert(projects)
    .values({ name: "Usage test", slug: `it-${randomUUID()}` })
    .returning();
  projectId = project.id;

  const [price] = await db
    .insert(modelPricing)
    .values({
      provider: "anthropic",
      model,
      inputPerMTokUsd: "3",
      outputPerMTokUsd: "15",
      cachedInputPerMTokUsd: "0.3",
      effectiveFrom: new Date("2026-01-01T00:00:00Z"),
    })
    .returning();
  pricingId = price.id;
});

afterAll(async () => {
  // Deleting the project cascades to its usage events.
  await db.delete(projects).where(eq(projects.id, projectId));
  await db.delete(modelPricing).where(inArray(modelPricing.id, [pricingId]));
  await client.end();
});

function usage(overrides: Partial<UsageInput> = {}): UsageInput {
  return {
    projectId,
    provider: "anthropic",
    model,
    inputTokens: 1_000_000,
    outputTokens: 100_000,
    cachedInputTokens: 400_000,
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

  it("returns no_pricing before the model's first price", async () => {
    expect(
      await recordUsage(
        db,
        usage({ occurredAt: new Date("2025-06-01T00:00:00Z") }),
      ),
    ).toEqual({ ok: false, error: "no_pricing" });
  });

  it("returns no_pricing for an unknown model", async () => {
    expect(
      await recordUsage(db, usage({ model: `missing-${randomUUID()}` })),
    ).toEqual({ ok: false, error: "no_pricing" });
  });

  it("returns project_not_found for an unknown project", async () => {
    expect(await recordUsage(db, usage({ projectId: randomUUID() }))).toEqual({
      ok: false,
      error: "project_not_found",
    });
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

  it("returns request_id_conflict when the retry describes different usage", async () => {
    const requestId = `req-${randomUUID()}`;
    await recordUsage(db, usage({ requestId }));
    expect(
      await recordUsage(db, usage({ requestId, outputTokens: 1 })),
    ).toEqual({ ok: false, error: "request_id_conflict" });
    expect(await countEvents(requestId)).toBe(1);
  });

  it("never returns another project's event for the same request id", async () => {
    const [other] = await db
      .insert(projects)
      .values({ name: "Other project", slug: `it-${randomUUID()}` })
      .returning();
    try {
      const requestId = `req-${randomUUID()}`;
      await recordUsage(db, usage({ requestId }));
      expect(
        await recordUsage(db, usage({ requestId, projectId: other.id })),
      ).toEqual({ ok: false, error: "request_id_conflict" });
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
