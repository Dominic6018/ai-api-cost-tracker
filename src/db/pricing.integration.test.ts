import "dotenv/config";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { calculateCostUsd } from "@/lib/cost";
import { parseEnv } from "@/lib/env";
import { findEffectivePricing } from "./pricing";
import { modelPricing } from "./schema";

// Runs against the database in DATABASE_URL after `npm run db:migrate`.
const client = postgres(parseEnv().DATABASE_URL, {
  max: 1,
  onnotice: () => {},
});
const db = drizzle(client);

// Unique per run so tests never collide with real or leftover pricing rows.
const model = `it-pricing-${randomUUID()}`;
const createdIds: string[] = [];

beforeAll(async () => {
  const rows = await db
    .insert(modelPricing)
    .values([
      {
        provider: "anthropic",
        model,
        inputPerMTokUsd: "3",
        outputPerMTokUsd: "15",
        cachedInputPerMTokUsd: "0.3",
        effectiveFrom: new Date("2026-01-01T00:00:00Z"),
        effectiveTo: new Date("2026-02-01T00:00:00Z"),
      },
      {
        provider: "anthropic",
        model,
        inputPerMTokUsd: "2",
        outputPerMTokUsd: "10",
        effectiveFrom: new Date("2026-02-01T00:00:00Z"),
      },
      // Same model name under another provider must not be picked up.
      {
        provider: "openai",
        model,
        inputPerMTokUsd: "99",
        outputPerMTokUsd: "99",
        effectiveFrom: new Date("2025-01-01T00:00:00Z"),
      },
    ])
    .returning({ id: modelPricing.id });
  createdIds.push(...rows.map((r) => r.id));
});

afterAll(async () => {
  if (createdIds.length > 0) {
    await db.delete(modelPricing).where(inArray(modelPricing.id, createdIds));
  }
  await client.end();
});

describe("findEffectivePricing", () => {
  it("returns the price in effect within a closed range", async () => {
    const result = await findEffectivePricing(db, {
      provider: "anthropic",
      model,
      at: new Date("2026-01-15T00:00:00Z"),
    });
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.pricing).toEqual({
      inputPerMTokUsd: 3,
      outputPerMTokUsd: 15,
      cachedInputPerMTokUsd: 0.3,
    });
    expect(result.row.model).toBe(model);
  });

  it("switches to the new price exactly at its effective_from", async () => {
    const result = await findEffectivePricing(db, {
      provider: "anthropic",
      model,
      at: new Date("2026-02-01T00:00:00Z"),
    });
    expect(result.found && result.pricing.inputPerMTokUsd).toBe(2);
  });

  it("produces prices calculateCostUsd accepts", async () => {
    const result = await findEffectivePricing(db, {
      provider: "anthropic",
      model,
      at: new Date("2026-03-01T00:00:00Z"),
    });
    if (!result.found) throw new Error("expected pricing");
    expect(
      calculateCostUsd(
        { inputTokens: 1_000_000, outputTokens: 1_000_000 },
        result.pricing,
      ),
    ).toBe(12);
  });

  it("returns not found before the first price", async () => {
    expect(
      await findEffectivePricing(db, {
        provider: "anthropic",
        model,
        at: new Date("2025-06-01T00:00:00Z"),
      }),
    ).toEqual({ found: false, reason: "no_pricing" });
  });

  it("returns not found for an unknown model", async () => {
    const result = await findEffectivePricing(db, {
      provider: "anthropic",
      model: `missing-${randomUUID()}`,
      at: new Date("2026-01-15T00:00:00Z"),
    });
    expect(result.found).toBe(false);
  });

  it("does not match the same model name from another provider", async () => {
    const result = await findEffectivePricing(db, {
      provider: "openai",
      model,
      at: new Date("2026-01-15T00:00:00Z"),
    });
    expect(result.found && result.pricing.inputPerMTokUsd).toBe(99);
  });
});
