import "dotenv/config";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseEnv } from "@/lib/env";
import { getSpendReport } from "./reports";
import { projects, usageEvents } from "./schema";

// Runs against the database in DATABASE_URL after `npm run db:migrate`.
const client = postgres(parseEnv().DATABASE_URL, {
  max: 1,
  onnotice: () => {},
});
const db = drizzle(client);

let projectId: string;
let otherProjectId: string;
const start = new Date("2040-06-01T00:00:00Z");
const end = new Date("2040-06-03T00:00:00Z");

beforeAll(async () => {
  const created = await db
    .insert(projects)
    .values([
      { name: "Reports", slug: `it-${randomUUID()}` },
      { name: "Reports other", slug: `it-${randomUUID()}` },
    ])
    .returning({ id: projects.id });
  [projectId, otherProjectId] = created.map((p) => p.id);
  const event = (
    occurredAt: string,
    costUsd: string,
    extra: Record<string, unknown> = {},
  ) => ({
    projectId,
    provider: "openai" as const,
    model: "gpt-4.1",
    inputTokens: 1000,
    cachedInputTokens: 100,
    cacheWriteInputTokens: 10,
    outputTokens: 50,
    costUsd,
    occurredAt: new Date(occurredAt),
    ...extra,
  });
  await db.insert(usageEvents).values([
    event("2040-06-01T00:00:00Z", "0.100001", { customerId: "acme" }),
    event("2040-06-01T23:59:59Z", "0.200002", { customerId: "acme" }),
    event("2040-06-02T12:00:00Z", "0.400000", {
      provider: "anthropic",
      model: "claude-haiku-5-5",
      customerId: "globex",
    }),
    event("2040-06-02T13:00:00Z", "0.050000"),
    // Outside the range, and another project: excluded.
    event("2040-06-03T00:00:00Z", "9.000000"),
    event("2040-05-31T23:59:59Z", "9.000000"),
    event("2040-06-01T12:00:00Z", "9.000000", { projectId: otherProjectId }),
  ]);
});

afterAll(async () => {
  await db
    .delete(projects)
    .where(inArray(projects.id, [projectId, otherProjectId]));
  await client.end();
});

const report = (groupBy: Parameters<typeof getSpendReport>[1]["groupBy"]) =>
  getSpendReport(db, { projectId, start, end, groupBy });

describe("getSpendReport", () => {
  it("totals one project's range exactly", async () => {
    expect((await report("day")).totals).toEqual({
      costUsd: "0.750003",
      requests: 4,
      inputTokens: "4000",
      cachedInputTokens: "400",
      cacheWriteInputTokens: "40",
      outputTokens: "200",
    });
  });

  it("lists days in order, with UTC day boundaries", async () => {
    const { groups, truncated } = await report("day");
    expect(groups.map((g) => [g.key, g.costUsd, g.requests])).toEqual([
      ["2040-06-01", "0.300003", 2],
      ["2040-06-02", "0.450000", 2],
    ]);
    expect(truncated).toBe(false);
  });

  it("lists other groupings by cost, with unset values as null", async () => {
    const byCustomer = await report("customer");
    expect(byCustomer.groups.map((g) => [g.key, g.costUsd])).toEqual([
      ["globex", "0.400000"],
      ["acme", "0.300003"],
      [null, "0.050000"],
    ]);
    const byProvider = await report("provider");
    // Anthropic $0.40; OpenAI $0.100001 + $0.200002 + $0.05 = $0.350003.
    expect(byProvider.groups.map((g) => g.key)).toEqual([
      "anthropic",
      "openai",
    ]);
    const byModel = await report("model");
    expect(byModel.groups.map((g) => g.key)).toEqual([
      "claude-haiku-5-5",
      "gpt-4.1",
    ]);
  });

  it("returns zero totals and no groups for an empty range", async () => {
    const empty = await getSpendReport(db, {
      projectId,
      start: new Date("2099-01-01T00:00:00Z"),
      end: new Date("2099-01-02T00:00:00Z"),
      groupBy: "day",
    });
    expect(empty).toEqual({
      totals: {
        costUsd: "0.000000",
        requests: 0,
        inputTokens: "0",
        cachedInputTokens: "0",
        cacheWriteInputTokens: "0",
        outputTokens: "0",
      },
      groups: [],
      truncated: false,
    });
  });
});
