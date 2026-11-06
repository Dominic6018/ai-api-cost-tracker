import "dotenv/config";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseEnv } from "@/lib/env";
import { recordedDailyCost } from "./reconcile";
import { projects, usageEvents } from "./schema";

// Runs against the database in DATABASE_URL after `npm run db:migrate`.
const client = postgres(parseEnv().DATABASE_URL, {
  max: 1,
  onnotice: () => {},
});
const db = drizzle(client);

// Unique model names and far-future days keep other tests' rows out.
const sonnet = `it-sonnet-${randomUUID()}`;
const haiku = `it-haiku-${randomUUID()}`;
const projectIds: string[] = [];

async function newProject() {
  const [project] = await db
    .insert(projects)
    .values({ name: "Reconcile test", slug: `it-${randomUUID()}` })
    .returning();
  projectIds.push(project.id);
  return project.id;
}

beforeAll(async () => {
  const a = await newProject();
  const b = await newProject();
  const event = (
    projectId: string,
    model: string,
    costUsd: string,
    occurredAt: string,
    provider: "anthropic" | "openai" = "anthropic",
    webSearchCostUsd = "0",
  ) => ({
    projectId,
    provider,
    model,
    inputTokens: 1,
    outputTokens: 1,
    costUsd,
    webSearchCostUsd,
    webSearchRequests: webSearchCostUsd === "0" ? 0 : 1,
    occurredAt: new Date(occurredAt),
  });
  await db.insert(usageEvents).values([
    // Two projects, same day and model: summed exactly.
    event(a, sonnet, "0.100001", "2041-03-01T00:00:00Z"),
    // $0.01 of this one is web search, kept apart from tokens.
    event(
      b,
      sonnet,
      "0.200002",
      "2041-03-01T23:59:59.999Z",
      "anthropic",
      "0.010000",
    ),
    event(a, haiku, "0.083750", "2041-03-01T12:00:00Z"),
    // The next UTC day.
    event(a, sonnet, "1.000000", "2041-03-02T00:00:00Z"),
    // Outside the range, and another provider: excluded.
    event(a, sonnet, "9.000000", "2041-03-03T00:00:00Z"),
    event(a, sonnet, "9.000000", "2041-02-28T23:59:59Z"),
    event(a, sonnet, "9.000000", "2041-03-01T06:00:00Z", "openai"),
  ]);
});

afterAll(async () => {
  for (const id of projectIds) {
    await db.delete(projects).where(eq(projects.id, id));
  }
  await client.end();
});

describe("recordedDailyCost", () => {
  it("sums one provider's token and web search cost per UTC day and model, across projects", async () => {
    const rows = await recordedDailyCost(db, {
      provider: "anthropic",
      from: new Date("2041-03-01T00:00:00Z"),
      to: new Date("2041-03-03T00:00:00Z"),
    });
    const ours = rows.filter((r) => r.model === sonnet || r.model === haiku);
    expect(ours).toEqual(
      expect.arrayContaining([
        {
          day: "2041-03-01",
          model: sonnet,
          micros: 290_003n,
          webSearchMicros: 10_000n,
        },
        {
          day: "2041-03-01",
          model: haiku,
          micros: 83_750n,
          webSearchMicros: 0n,
        },
        {
          day: "2041-03-02",
          model: sonnet,
          micros: 1_000_000n,
          webSearchMicros: 0n,
        },
      ]),
    );
    expect(ours).toHaveLength(3);
  });
});
