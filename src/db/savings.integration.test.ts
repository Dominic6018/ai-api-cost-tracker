import "dotenv/config";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { parseEnv } from "@/lib/env";
import { estimateSavings } from "@/lib/savings";
import { getCurrentPrices, getSavingsInputs } from "./savings";
import { modelPricing, organizations, projects, usageEvents } from "./schema";

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

const period = {
  from: new Date("2026-10-01T00:00:00Z"),
  to: new Date("2026-11-01T00:00:00Z"),
};

async function setup() {
  const [organization] = await db
    .insert(organizations)
    .values({ name: "Savings test", slug: `it-${randomUUID()}` })
    .returning();
  organizationIds.push(organization.id);
  const [project] = await db
    .insert(projects)
    .values({
      organizationId: organization.id,
      name: "Project",
      slug: `it-${randomUUID()}`,
    })
    .returning();
  const big = `it-big-${randomUUID()}`;
  const mini = `it-mini-${randomUUID()}`;
  priceModels.push(big, mini);
  const usage = (
    values: Partial<typeof usageEvents.$inferInsert> & {
      costUsd: string | null;
    },
  ) =>
    db.insert(usageEvents).values({
      projectId: project.id,
      provider: "openai",
      model: big,
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      pricingStatus: values.costUsd === null ? "unpriced" : "priced",
      unpricedReason: values.costUsd === null ? "no_pricing" : null,
      occurredAt: new Date("2026-10-10T00:00:00Z"),
      ...values,
    });
  return {
    scope: { organizationId: organization.id },
    project,
    big,
    mini,
    usage,
  };
}

describe("savings inputs", () => {
  it("sums standard-tier usage by kind, and counts what's left out", async () => {
    const t = await setup();
    await t.usage({ costUsd: "2.8", cachedInputTokens: 200_000 });
    await t.usage({ costUsd: "2.8" });
    // Left out: another tier, no price, another period.
    await t.usage({ costUsd: "1.4", serviceTier: "batch" });
    await t.usage({ costUsd: null });
    await t.usage({
      costUsd: "9",
      occurredAt: new Date("2026-11-01T00:00:00Z"),
    });

    const inputs = await getSavingsInputs(db, t.scope, period);
    expect(inputs).toEqual({
      workloads: [
        {
          provider: "openai",
          model: t.big,
          requests: 2n,
          costMicros: 5_600_000n,
          parts: {
            input: 2_000_000n,
            cached: 200_000n,
            writes: 0n,
            writes1h: 0n,
            output: 200_000n,
          },
        },
      ],
      unpriced: 1,
      otherTiers: 1,
    });
    // Another organization sees none of it.
    const other = await setup();
    expect((await getSavingsInputs(db, other.scope, period)).workloads).toEqual(
      [],
    );
  });
});

describe("current prices and estimates", () => {
  it("uses the standard price in effect now, end to end", async () => {
    const t = await setup();
    const now = new Date("2026-11-15T00:00:00Z");
    await db.insert(modelPricing).values([
      // Ended: not current.
      {
        provider: "openai",
        model: t.big,
        inputPerMTokUsd: "50",
        outputPerMTokUsd: "50",
        effectiveFrom: new Date("2026-01-01T00:00:00Z"),
        effectiveTo: new Date("2026-06-01T00:00:00Z"),
      },
      {
        provider: "openai",
        model: t.big,
        inputPerMTokUsd: "2",
        cachedInputPerMTokUsd: "0.5",
        outputPerMTokUsd: "8",
        batchMultiplier: "0.5",
        effectiveFrom: new Date("2026-06-01T00:00:00Z"),
      },
      // Another tier: not offered as standard.
      {
        provider: "openai",
        model: t.big,
        serviceTier: "flex",
        inputPerMTokUsd: "1",
        outputPerMTokUsd: "4",
        effectiveFrom: new Date("2026-06-01T00:00:00Z"),
      },
      {
        provider: "openai",
        model: t.mini,
        inputPerMTokUsd: "0.4",
        cachedInputPerMTokUsd: "0.1",
        outputPerMTokUsd: "1.6",
        effectiveFrom: new Date("2026-06-01T00:00:00Z"),
      },
    ]);
    const prices = (await getCurrentPrices(db, now)).filter((p) =>
      [t.big, t.mini].includes(p.model),
    );
    expect(prices.find((p) => p.model === t.big)?.pricing).toMatchObject({
      inputPerMTokUsd: 2,
      outputPerMTokUsd: 8,
      batchMultiplier: 0.5,
    });
    expect(prices).toHaveLength(2);

    await t.usage({ costUsd: "2.8" });
    const { workloads } = await getSavingsInputs(db, t.scope, period);
    const [row] = estimateSavings(workloads, prices).rows;
    expect(row).toMatchObject({
      costMicros: 2_800_000n,
      batch: { savingMicros: 1_400_000n },
      cachingPer10Percent: 150_000n,
      alternative: {
        model: t.mini,
        costMicros: 560_000n,
        savingMicros: 2_240_000n,
      },
    });
  });
});
