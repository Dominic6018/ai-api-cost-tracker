import "dotenv/config";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseEnv } from "@/lib/env";
import type { UsageInput } from "@/lib/usage";
import {
  countIngestion,
  getIngestionHealth,
  recordAndCount,
} from "./ingestion-health";
import { modelPricing, organizations, projects } from "./schema";

// Runs against the database in DATABASE_URL after `npm run db:migrate`.
const client = postgres(parseEnv().DATABASE_URL, {
  max: 1,
  onnotice: () => {},
});
const db = drizzle(client);

const model = `it-ingestion-${randomUUID()}`;
let organizationId: string;
let projectId: string;
let priceId: string;

beforeAll(async () => {
  const [organization] = await db
    .insert(organizations)
    .values({ name: "Ingestion test", slug: `it-${randomUUID()}` })
    .returning();
  organizationId = organization.id;
  const [project] = await db
    .insert(projects)
    .values({
      name: "Ingestion test",
      slug: `it-${randomUUID()}`,
      organizationId,
    })
    .returning();
  projectId = project.id;
  const [price] = await db
    .insert(modelPricing)
    .values({
      provider: "other",
      model,
      inputPerMTokUsd: "1",
      outputPerMTokUsd: "1",
      effectiveFrom: new Date("2026-01-01T00:00:00Z"),
    })
    .returning();
  priceId = price.id;
});

afterAll(async () => {
  // Deleting the project cascades to its usage and counts.
  await db.delete(projects).where(eq(projects.id, projectId));
  await db.delete(organizations).where(eq(organizations.id, organizationId));
  await db.delete(modelPricing).where(eq(modelPricing.id, priceId));
  await client.end();
});

const usage = (overrides: Partial<UsageInput> = {}): UsageInput => ({
  projectId,
  provider: "other",
  model,
  inputTokens: 1_000,
  outputTokens: 0,
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
  occurredAt: new Date(),
  ...overrides,
});

describe("ingestion health", () => {
  it("counts each outcome per project and day", async () => {
    const requestId = `req-${randomUUID()}`;
    await recordAndCount(db, usage({ requestId }));
    await recordAndCount(db, usage({ requestId }));
    await recordAndCount(db, usage({ requestId, outputTokens: 1 }));
    await recordAndCount(db, usage({ model: `missing-${randomUUID()}` }));
    await recordAndCount(db, usage());
    await countIngestion(db, projectId, "invalid", 3);

    const rows = await getIngestionHealth(db, { organizationId }, 7);
    expect(rows).toEqual([
      {
        projectId,
        projectName: "Ingestion test",
        day: new Date().toISOString().slice(0, 10),
        stored: 2,
        unpriced: 1,
        replayed: 1,
        conflict: 1,
        invalid: 3,
      },
    ]);
  });

  it("is scoped to the organization", async () => {
    expect(
      await getIngestionHealth(db, { organizationId: randomUUID() }, 7),
    ).toEqual([]);
  });

  it("keeps days apart, and leaves out ones before the window", async () => {
    const yesterday = new Date(Date.now() - 86_400_000);
    const longAgo = new Date(Date.now() - 30 * 86_400_000);
    await countIngestion(db, projectId, "stored", 5, yesterday);
    await countIngestion(db, projectId, "stored", 9, longAgo);
    const days = (await getIngestionHealth(db, { organizationId }, 7)).map(
      (r) => [r.day, r.stored],
    );
    expect(days).toEqual([
      [new Date().toISOString().slice(0, 10), 2],
      [yesterday.toISOString().slice(0, 10), 5],
    ]);
  });

  it("doesn't fail when the count can't be saved", async () => {
    await expect(
      countIngestion(db, randomUUID(), "stored"),
    ).resolves.toBeUndefined();
  });
});
