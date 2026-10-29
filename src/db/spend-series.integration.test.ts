import "dotenv/config";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseEnv } from "@/lib/env";
import { projects, usageEvents } from "./schema";
import { getDailySpend, getSpendBreakdown } from "./spend-series";

// Runs against the database in DATABASE_URL after `npm run db:migrate`.
const client = postgres(parseEnv().DATABASE_URL, {
  max: 1,
  onnotice: () => {},
});
const db = drizzle(client);

// Dates years ahead, so no other usage in the database falls in range and
// totals can be checked exactly.
const start = new Date("2032-05-01T00:00:00Z");
let alpha: string;
let beta: string;

beforeAll(async () => {
  const created = await db
    .insert(projects)
    .values([
      { name: "Series Alpha", slug: `it-${randomUUID()}` },
      { name: "Series Beta", slug: `it-${randomUUID()}` },
    ])
    .returning({ id: projects.id });
  [alpha, beta] = created.map((p) => p.id);

  const event = (
    projectId: string,
    occurredAt: string,
    provider: "openai" | "anthropic",
    model: string,
    costUsd: string,
    tokens: [number, number, number],
  ) => ({
    projectId,
    provider,
    model,
    costUsd,
    occurredAt: new Date(occurredAt),
    inputTokens: tokens[0],
    outputTokens: tokens[1],
    cachedInputTokens: tokens[2],
  });

  await db.insert(usageEvents).values([
    // Before the range
    event(alpha, "2032-04-30T23:59:59Z", "openai", "m-old", "50", [1, 1, 0]),
    // 1 May UTC, including the first and last moments of the day
    event(
      alpha,
      "2032-05-01T00:00:00Z",
      "openai",
      "m-a",
      "1.000000",
      [1000, 100, 0],
    ),
    event(
      alpha,
      "2032-05-01T23:59:59Z",
      "anthropic",
      "m-b",
      "2.500000",
      [2000, 200, 500],
    ),
    // 2 May has no usage
    // 3 May, late in the evening west of UTC but already the 3rd in UTC
    event(
      beta,
      "2032-05-03T00:30:00Z",
      "openai",
      "m-a",
      "0.000001",
      [10, 1, 0],
    ),
    // Sorts below "2.5" as text but is the largest amount
    event(
      beta,
      "2032-05-03T12:00:00Z",
      "anthropic",
      "m-c",
      "10.000000",
      [5000, 500, 0],
    ),
  ]);
});

afterAll(async () => {
  // Deleting the projects cascades to their usage events.
  await db.delete(projects).where(inArray(projects.id, [alpha, beta]));
  await client.end();
});

describe("getDailySpend", () => {
  it("sums by UTC day across all projects and skips empty days", async () => {
    expect(await getDailySpend(db, { start })).toEqual([
      { day: "2032-05-01", costUsd: "3.500000" },
      { day: "2032-05-03", costUsd: "10.000001" },
    ]);
  });

  it("filters to one project", async () => {
    expect(await getDailySpend(db, { start, projectId: beta })).toEqual([
      { day: "2032-05-03", costUsd: "10.000001" },
    ]);
  });
});

describe("getSpendBreakdown", () => {
  it("totals spend and tokens per provider, highest spend first", async () => {
    const { byProvider } = await getSpendBreakdown(db, { start });
    expect(byProvider).toEqual([
      {
        provider: "anthropic",
        costUsd: "12.500000",
        inputTokens: "7000",
        outputTokens: "700",
        cachedInputTokens: "500",
        events: 2,
      },
      {
        provider: "openai",
        costUsd: "1.000001",
        inputTokens: "1010",
        outputTokens: "101",
        cachedInputTokens: "0",
        events: 2,
      },
    ]);
  });

  it("orders models by numeric spend, not text", async () => {
    const { byModel } = await getSpendBreakdown(db, { start });
    expect(byModel.map((r) => [r.model, r.costUsd])).toEqual([
      ["m-c", "10.000000"],
      ["m-b", "2.500000"],
      ["m-a", "1.000001"],
    ]);
  });

  it("filters to one project", async () => {
    const { byModel } = await getSpendBreakdown(db, {
      start,
      projectId: alpha,
    });
    expect(byModel.map((r) => r.model)).toEqual(["m-b", "m-a"]);
  });
});
