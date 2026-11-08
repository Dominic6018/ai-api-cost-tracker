import "dotenv/config";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseEnv } from "@/lib/env";
import { getSpendByAttribution } from "./attribution-spend";
import { projects, usageEvents } from "./schema";
import { ALL_ORGANIZATIONS } from "./scope";

// Runs against the database in DATABASE_URL after `npm run db:migrate`.
const client = postgres(parseEnv().DATABASE_URL, {
  max: 1,
  onnotice: () => {},
});
const db = drizzle(client);

// A project of its own, and a start date after other tests' rows.
const start = new Date("2036-03-01T00:00:00Z");
let projectId: string;
let otherProjectId: string;

beforeAll(async () => {
  const created = await db
    .insert(projects)
    .values([
      { name: "Breakdown", slug: `it-${randomUUID()}` },
      { name: "Breakdown other", slug: `it-${randomUUID()}` },
    ])
    .returning({ id: projects.id });
  [projectId, otherProjectId] = created.map((p) => p.id);

  const event = (
    costUsd: string,
    customerId: string | null,
    occurredAt = "2036-03-02T00:00:00Z",
    project = projectId,
  ) => ({
    projectId: project,
    provider: "openai" as const,
    model: "m",
    inputTokens: 1,
    outputTokens: 1,
    costUsd,
    customerId,
    occurredAt: new Date(occurredAt),
  });
  await db.insert(usageEvents).values([
    event("1.000001", "acme"),
    event("2.000002", "acme"),
    event("0.500000", "globex"),
    event("0.700000", null),
    event("0.100000", "initech"),
    // Before the start, and another project: excluded unless asked for.
    event("9.000000", "acme", "2036-02-29T23:59:59Z"),
    event("4.000000", "acme", "2036-03-02T00:00:00Z", otherProjectId),
  ]);
});

afterAll(async () => {
  await db
    .delete(projects)
    .where(inArray(projects.id, [projectId, otherProjectId]));
  await client.end();
});

describe("getSpendByAttribution", () => {
  it("groups exact sums by the field, highest first, with not-set as null", async () => {
    const result = await getSpendByAttribution(db, ALL_ORGANIZATIONS, {
      key: "customerId",
      start,
      projectId,
      limit: 50,
    });
    expect(result.top).toEqual([
      { value: "acme", costUsd: "3.000003", events: 2 },
      { value: null, costUsd: "0.700000", events: 1 },
      { value: "globex", costUsd: "0.500000", events: 1 },
      { value: "initech", costUsd: "0.100000", events: 1 },
    ]);
    expect(result.totals).toEqual({
      costUsd: "4.300003",
      events: 5,
      groups: 4, // three customers plus "not set"
    });
  });

  it("limits the groups returned but totals everything", async () => {
    const result = await getSpendByAttribution(db, ALL_ORGANIZATIONS, {
      key: "customerId",
      start,
      projectId,
      limit: 2,
    });
    expect(result.top.map((g) => g.value)).toEqual(["acme", null]);
    expect(result.totals).toMatchObject({ costUsd: "4.300003", groups: 4 });
  });

  it("covers every project when none is given", async () => {
    const result = await getSpendByAttribution(db, ALL_ORGANIZATIONS, {
      key: "customerId",
      start,
      limit: 50,
    });
    const acme = result.top.find((g) => g.value === "acme");
    // Other tests' rows are before 2036, so only these two projects count.
    expect(acme).toEqual({ value: "acme", costUsd: "7.000003", events: 3 });
  });

  it("groups by another field, where everything is not set", async () => {
    const result = await getSpendByAttribution(db, ALL_ORGANIZATIONS, {
      key: "feature",
      start,
      projectId,
      limit: 50,
    });
    expect(result.top).toEqual([
      { value: null, costUsd: "4.300003", events: 5 },
    ]);
    expect(result.totals.groups).toBe(1);
  });

  it("returns zero totals for a range without usage", async () => {
    const result = await getSpendByAttribution(db, ALL_ORGANIZATIONS, {
      key: "customerId",
      start: new Date("2099-01-01T00:00:00Z"),
      projectId,
      limit: 50,
    });
    expect(result).toEqual({
      top: [],
      totals: { costUsd: "0.000000", events: 0, groups: 0 },
    });
  });
});
