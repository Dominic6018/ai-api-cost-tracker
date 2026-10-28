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

  it("returns duplicate_request for a repeated provider request id", async () => {
    const requestId = `req-${randomUUID()}`;
    expect((await recordUsage(db, usage({ requestId }))).ok).toBe(true);
    expect(await recordUsage(db, usage({ requestId }))).toEqual({
      ok: false,
      error: "duplicate_request",
    });
  });
});
