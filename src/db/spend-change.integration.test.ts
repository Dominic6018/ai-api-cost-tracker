import "dotenv/config";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { parseEnv } from "@/lib/env";
import { explainSpendChange } from "@/lib/spend-change";
import { parseUsagePayload } from "@/lib/usage";
import { modelPricing, organizations, projects, usageEvents } from "./schema";
import { ALL_ORGANIZATIONS } from "./scope";
import { getReferencePrices, getSpendChangeInputs } from "./spend-change";
import { recordUsage } from "./usage";

// Runs against the database in DATABASE_URL after `npm run db:migrate`.
const client = postgres(parseEnv().DATABASE_URL, {
  max: 1,
  onnotice: () => {},
});
const db = drizzle(client);

const organizationIds: string[] = [];
const priceModels: string[] = [];

afterAll(async () => {
  if (priceModels.length > 0) {
    await db
      .delete(modelPricing)
      .where(inArray(modelPricing.model, priceModels));
  }
  if (organizationIds.length > 0) {
    await db
      .delete(projects)
      .where(inArray(projects.organizationId, organizationIds));
    await db
      .delete(organizations)
      .where(inArray(organizations.id, organizationIds));
  }
  await client.end();
});

const periods = {
  before: {
    from: new Date("2026-09-01T00:00:00Z"),
    to: new Date("2026-10-01T00:00:00Z"),
  },
  after: {
    from: new Date("2026-10-01T00:00:00Z"),
    to: new Date("2026-11-01T00:00:00Z"),
  },
};

async function setup() {
  const [organization] = await db
    .insert(organizations)
    .values({ name: "Spend change test", slug: `it-${randomUUID()}` })
    .returning();
  organizationIds.push(organization.id);
  const [a, b] = await db
    .insert(projects)
    .values(
      ["a", "b"].map((s) => ({
        organizationId: organization.id,
        name: `Project ${s}`,
        slug: `it-${s}-${randomUUID()}`,
      })),
    )
    .returning();
  const usage = (
    projectId: string,
    model: string,
    occurredAt: string,
    costUsd: string | null,
    inputTokens = 900,
    outputTokens = 100,
  ) =>
    db.insert(usageEvents).values({
      projectId,
      provider: "openai",
      model,
      inputTokens,
      outputTokens,
      costUsd,
      pricingStatus: costUsd === null ? "unpriced" : "priced",
      unpricedReason: costUsd === null ? "no_pricing" : null,
      occurredAt: new Date(occurredAt),
    });
  return { scope: { organizationId: organization.id }, a, b, usage };
}

describe("getSpendChangeInputs", () => {
  it("sums each model's priced usage in each period", async () => {
    const t = await setup();
    await t.usage(t.a.id, "gpt-4.1", "2026-09-01T00:00:00Z", "1.000000");
    await t.usage(t.b.id, "gpt-4.1", "2026-09-30T23:59:59Z", "1.000000");
    await t.usage(
      t.a.id,
      "gpt-4.1",
      "2026-10-15T00:00:00Z",
      "2.500000",
      1800,
      200,
    );
    await t.usage(t.a.id, "gpt-4.1-mini", "2026-10-31T23:59:59Z", "0.250000");
    // Outside both periods, unpriced, or in another organization.
    await t.usage(t.a.id, "gpt-4.1", "2026-08-31T23:59:59Z", "50");
    await t.usage(t.a.id, "gpt-4.1", "2026-11-01T00:00:00Z", "50");
    await t.usage(t.a.id, "gpt-4.1", "2026-10-02T00:00:00Z", null);
    const elsewhere = await setup();
    await elsewhere.usage(
      elsewhere.a.id,
      "gpt-4.1",
      "2026-10-02T00:00:00Z",
      "50",
    );

    const inputs = await getSpendChangeInputs(db, t.scope, periods);
    expect(inputs.unpriced).toEqual({ before: 0, after: 1 });
    const byModel = Object.fromEntries(inputs.models.map((m) => [m.model, m]));
    expect(byModel["gpt-4.1"]).toEqual({
      provider: "openai",
      model: "gpt-4.1",
      before: {
        requests: 2n,
        tokens: 2000n,
        costMicros: 2_000_000n,
        parts: {
          input: 1800n,
          cached: 0n,
          writes: 0n,
          writes1h: 0n,
          output: 200n,
        },
      },
      after: {
        requests: 1n,
        tokens: 2000n,
        costMicros: 2_500_000n,
        parts: {
          input: 1800n,
          cached: 0n,
          writes: 0n,
          writes1h: 0n,
          output: 200n,
        },
      },
    });
    expect(byModel["gpt-4.1-mini"]).toMatchObject({
      before: null,
      after: { requests: 1n, tokens: 1000n, costMicros: 250_000n },
    });
    expect(inputs.models).toHaveLength(2);

    const result = explainSpendChange(inputs.models);
    expect(result).toMatchObject({
      beforeMicros: 2_000_000n,
      afterMicros: 2_750_000n,
      changeMicros: 750_000n,
    });
  });

  it("can be limited to one project", async () => {
    const t = await setup();
    await t.usage(t.a.id, "gpt-4.1", "2026-09-10T00:00:00Z", "1");
    await t.usage(t.b.id, "gpt-4.1", "2026-10-10T00:00:00Z", "3");
    const onlyB = await getSpendChangeInputs(db, t.scope, periods, t.b.id);
    expect(onlyB.models).toEqual([
      {
        provider: "openai",
        model: "gpt-4.1",
        before: null,
        after: expect.objectContaining({
          requests: 1n,
          tokens: 1000n,
          costMicros: 3_000_000n,
        }),
      },
    ]);
    // A project from another organization finds nothing.
    const other = await setup();
    expect(
      (await getSpendChangeInputs(db, other.scope, periods, t.b.id)).models,
    ).toEqual([]);
    // Without an organization, every organization counts.
    const all = await getSpendChangeInputs(db, ALL_ORGANIZATIONS, periods);
    expect(all.models.length).toBeGreaterThan(0);
  });

  it("counts each kind of token separately", async () => {
    const t = await setup();
    await db.insert(usageEvents).values({
      projectId: t.a.id,
      provider: "anthropic",
      model: "claude-sonnet-5-5",
      inputTokens: 10_000,
      cachedInputTokens: 6_000,
      cacheWriteInputTokens: 3_000,
      cacheWrite1hInputTokens: 1_000,
      outputTokens: 500,
      costUsd: "0.01",
      occurredAt: new Date("2026-10-05T00:00:00Z"),
    });
    const { models } = await getSpendChangeInputs(db, t.scope, periods);
    expect(models[0].after?.parts).toEqual({
      input: 10_000n,
      cached: 6_000n,
      writes: 3_000n,
      writes1h: 1_000n,
      output: 500n,
    });
  });
});

describe("getReferencePrices", () => {
  it("uses the rates in effect at the end of each period", async () => {
    const name = `it-model-${randomUUID()}`;
    priceModels.push(name);
    await db.insert(modelPricing).values([
      {
        provider: "openai",
        model: name,
        inputPerMTokUsd: "2",
        outputPerMTokUsd: "8",
        effectiveFrom: new Date("2026-01-01T00:00:00Z"),
        effectiveTo: new Date("2026-10-20T00:00:00Z"),
      },
      {
        provider: "openai",
        model: name,
        inputPerMTokUsd: "1.5",
        outputPerMTokUsd: "6",
        effectiveFrom: new Date("2026-10-20T00:00:00Z"),
      },
    ]);
    const used = { requests: 1n, tokens: 1n, costMicros: 1n };
    const prices = await getReferencePrices(
      db,
      [
        { provider: "openai", model: name, before: used, after: used },
        // Used in one period only: not needed, so not looked up.
        { provider: "openai", model: `${name}-new`, before: null, after: used },
      ],
      periods,
    );
    expect(prices.get(`openai/${name}`)).toMatchObject({
      before: { inputPerMTokUsd: 2, outputPerMTokUsd: 8 },
      after: { inputPerMTokUsd: 1.5, outputPerMTokUsd: 6 },
    });
    expect(prices.has(`openai/${name}-new`)).toBe(false);
  });
});

describe("why spend changed, end to end", () => {
  it("splits a change in usage priced by the tracker, with nothing left over", async () => {
    const t = await setup();
    const name = `it-model-${randomUUID()}`;
    priceModels.push(name);
    // $2 / $0.50 cached / $8 per 1M until October 20th, then output $6.
    await db.insert(modelPricing).values([
      {
        provider: "openai",
        model: name,
        inputPerMTokUsd: "2",
        cachedInputPerMTokUsd: "0.5",
        outputPerMTokUsd: "8",
        effectiveFrom: new Date("2026-01-01T00:00:00Z"),
        effectiveTo: new Date("2026-10-20T00:00:00Z"),
      },
      {
        provider: "openai",
        model: name,
        inputPerMTokUsd: "2",
        cachedInputPerMTokUsd: "0.5",
        outputPerMTokUsd: "6",
        effectiveFrom: new Date("2026-10-20T00:00:00Z"),
      },
    ]);
    const record = async (body: Record<string, unknown>) => {
      const parsed = parseUsagePayload(
        { provider: "openai", model: name, ...body },
        new Date("2026-11-15T00:00:00Z"),
      );
      if (!parsed.ok) throw new Error(JSON.stringify(parsed.fieldErrors));
      const stored = await recordUsage(db, {
        ...parsed.usage,
        projectId: t.a.id,
      });
      if (!stored.ok) throw new Error("not stored");
    };
    // September: two requests, nothing cached.
    for (const day of ["05", "25"]) {
      await record({
        inputTokens: 100_000,
        outputTokens: 10_000,
        occurredAt: `2026-09-${day}T12:00:00Z`,
      });
    }
    // Late October: three requests, half the input cached, more output.
    for (const day of ["21", "22", "23"]) {
      await record({
        inputTokens: 100_000,
        cachedInputTokens: 50_000,
        outputTokens: 20_000,
        occurredAt: `2026-10-${day}T12:00:00Z`,
      });
    }

    const inputs = await getSpendChangeInputs(db, t.scope, periods);
    const prices = await getReferencePrices(db, inputs.models, periods);
    const result = explainSpendChange(inputs.models, prices);
    // September: 2 x ($0.20 + $0.08) = $0.56. October: 3 x ($0.10 +
    // $0.025 + $0.12) = $0.735.
    expect(result).toMatchObject({
      beforeMicros: 560_000n,
      afterMicros: 735_000n,
      changeMicros: 175_000n,
    });
    const effects = result.effects;
    expect(Object.values(effects).reduce((a, b) => a + b, 0n)).toBe(175_000n);
    // One request more, on the same model.
    expect(effects.volume).toBe(280_000n);
    expect(effects.modelMix).toBe(0n);
    // October's 360,000 tokens at September's $0.56 per 220,000.
    expect(effects.tokensPerRequest).toBe(916_364n - 840_000n);
    // Cheaper cached input, dearer output share, and the new output rate.
    expect(effects.cacheRate).toBeLessThan(0n);
    expect(effects.inputOutputMix).toBeGreaterThan(0n);
    // October: 60,000 output at $2 less = -$0.12.
    expect(effects.price).toBe(-120_000n);
    // The rates model every request exactly, so nothing is left over.
    expect(effects.other).toBe(0n);
  });
});
