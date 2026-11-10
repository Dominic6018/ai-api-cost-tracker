import "dotenv/config";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseEnv } from "@/lib/env";
import type { UsageInput } from "@/lib/usage";
import { getSpendByAttribution } from "./attribution-spend";
import { COMMAND_LINE } from "./audit";
import {
  auditLog,
  modelPricing,
  organizations,
  projects,
  usageEvents,
} from "./schema";
import { getSpendOverview } from "./spend";
import { getDailySpend } from "./spend-series";
import { getUnpricedSummary, repriceUnpriced } from "./unpriced";
import { recordUsage } from "./usage";

// Runs against the database in DATABASE_URL after `npm run db:migrate`.
const client = postgres(parseEnv().DATABASE_URL, {
  max: 1,
  onnotice: () => {},
});
const db = drizzle(client);

const run = randomUUID();
const model = `it-unpriced-${run}`;
const occurredAt = new Date(Date.now() - 60 * 60 * 1000);
const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
let organizationId: string;
let projectId: string;
const priceIds: string[] = [];

beforeAll(async () => {
  const [organization] = await db
    .insert(organizations)
    .values({ name: "Unpriced test", slug: `it-${run}` })
    .returning();
  organizationId = organization.id;
  const [project] = await db
    .insert(projects)
    .values({
      name: "Unpriced test",
      slug: `it-${randomUUID()}`,
      organizationId,
    })
    .returning();
  projectId = project.id;
});

afterAll(async () => {
  await db.delete(projects).where(eq(projects.id, projectId));
  await db.delete(organizations).where(eq(organizations.id, organizationId));
  if (priceIds.length > 0) {
    await db.delete(modelPricing).where(inArray(modelPricing.id, priceIds));
  }
  await client.end();
});

const usage = (overrides: Partial<UsageInput> = {}): UsageInput => ({
  projectId,
  provider: "other",
  model,
  inputTokens: 1_000_000,
  outputTokens: 500_000,
  cachedInputTokens: 0,
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
  occurredAt,
  feature: "chat",
  ...overrides,
});

const scope = () => ({ organizationId });

const ours = () =>
  db.select().from(usageEvents).where(eq(usageEvents.projectId, projectId));

describe("unpriced usage", () => {
  it("is stored, counted, and kept out of every total", async () => {
    const first = await recordUsage(db, usage());
    const second = await recordUsage(db, usage({ inputTokens: 2_000_000 }));
    expect(first.ok && first.event.pricingStatus).toBe("unpriced");
    expect(second.ok && second.event.costUsd).toBeNull();

    expect(await getUnpricedSummary(db, scope(), since)).toEqual({
      events: 2,
      models: [{ provider: "other", model, reason: "no_pricing", events: 2 }],
    });
    // Another organization doesn't see them.
    expect(
      (await getUnpricedSummary(db, { organizationId: randomUUID() }, since))
        .events,
    ).toBe(0);

    // Totals count the events but sum no cost, without failing on nulls.
    const overview = await getSpendOverview(db, scope());
    expect(overview.totals).toMatchObject({
      last30Days: "0.000000",
      events: 2,
    });
    expect(
      (await getDailySpend(db, scope(), { start: since })).map(
        (d) => d.costUsd,
      ),
    ).toEqual(["0.000000"]);
    const { top } = await getSpendByAttribution(db, scope(), {
      key: "feature",
      start: since,
      limit: 5,
    });
    expect(top).toEqual([{ value: "chat", costUsd: "0.000000", events: 2 }]);
  });

  it("is priced once a price exists, exactly once", async () => {
    // A dry run with no price changes nothing.
    const before = await repriceUnpriced(db, COMMAND_LINE, { dryRun: true });
    expect(before.stillUnpriced.no_pricing).toBeGreaterThanOrEqual(2);

    const [price] = await db
      .insert(modelPricing)
      .values({
        provider: "other",
        model,
        inputPerMTokUsd: "1.25",
        outputPerMTokUsd: "2.5",
        effectiveFrom: new Date(occurredAt.getTime() - 60_000),
      })
      .returning();
    priceIds.push(price.id);

    // Two overlapping runs: each event is priced by exactly one of them.
    const [a, b] = await Promise.all([
      repriceUnpriced(db, COMMAND_LINE),
      repriceUnpriced(db, COMMAND_LINE),
    ]);
    expect(a.priced + b.priced).toBeGreaterThanOrEqual(2);

    const rows = await ours();
    expect(rows.map((r) => [r.pricingStatus, r.costUsd]).sort()).toEqual([
      // 1M × $1.25 + 500k × $2.50; 2M × $1.25 + 500k × $2.50
      ["priced", "2.500000"],
      ["priced", "3.750000"],
    ]);
    expect(rows.every((r) => r.unpricedReason === null)).toBe(true);
    expect(await getUnpricedSummary(db, scope(), since)).toEqual({
      events: 0,
      models: [],
    });
    expect((await getSpendOverview(db, scope())).totals.last30Days).toBe(
      "6.250000",
    );

    // Running again leaves them as they are.
    await repriceUnpriced(db, COMMAND_LINE);
    expect((await ours()).map((r) => r.costUsd).sort()).toEqual([
      "2.500000",
      "3.750000",
    ]);

    const entries = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, "usage.repriced"),
          eq(auditLog.actorLabel, "command line"),
        ),
      );
    expect(entries.length).toBeGreaterThan(0);
  });
});
