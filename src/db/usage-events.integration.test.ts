import "dotenv/config";
import { randomUUID } from "node:crypto";
import { inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseEnv } from "@/lib/env";
import type { UsageFilters } from "@/lib/usage-filters";
import { projects, usageEvents } from "./schema";
import { listUsageEvents, usageEventsQuery } from "./usage-events";

// Runs against the database in DATABASE_URL after `npm run db:migrate`.
const client = postgres(parseEnv().DATABASE_URL, {
  max: 1,
  onnotice: () => {},
});
const db = drizzle(client);

// Dates in 2033 so the date filter isolates this test's rows exactly.
const window = { from: "2033-06-01", to: "2033-06-03" };
let alpha: string;
let beta: string;
const ids: string[] = [];

beforeAll(async () => {
  const created = await db
    .insert(projects)
    .values([
      { name: "Events Alpha", slug: `it-${randomUUID()}` },
      { name: "Events Beta", slug: `it-${randomUUID()}` },
    ])
    .returning({ id: projects.id });
  [alpha, beta] = created.map((p) => p.id);

  const base = {
    inputTokens: 100,
    outputTokens: 10,
    cachedInputTokens: 0,
    costUsd: "0.001000",
  };
  // 12 events in the window: six share one timestamp to exercise the id tie-breaker,
  // and two differ only in microseconds, below JS Date precision.
  const rows = [
    ...Array.from({ length: 6 }, () => ({
      projectId: alpha,
      provider: "openai" as const,
      model: "m-a",
      occurredAt: sql`'2033-06-02T12:00:00.000000Z'::timestamptz`,
    })),
    {
      projectId: alpha,
      provider: "openai" as const,
      model: "m-a",
      occurredAt: sql`'2033-06-02T13:00:00.000001Z'::timestamptz`,
    },
    {
      projectId: alpha,
      provider: "openai" as const,
      model: "m-a",
      occurredAt: sql`'2033-06-02T13:00:00.000002Z'::timestamptz`,
    },
    ...["2033-06-01T00:00:00Z", "2033-06-03T23:59:59Z"].map((t) => ({
      projectId: beta,
      provider: "anthropic" as const,
      model: "m-b",
      occurredAt: sql`${t}::timestamptz`,
    })),
    {
      projectId: beta,
      provider: "anthropic" as const,
      model: "m-c",
      occurredAt: sql`'2033-06-02T08:00:00Z'::timestamptz`,
    },
    {
      projectId: beta,
      provider: "openai" as const,
      model: "m-a",
      occurredAt: sql`'2033-06-02T09:00:00Z'::timestamptz`,
    },
  ];
  // Outside the date window on both sides
  rows.push(
    {
      projectId: alpha,
      provider: "openai" as const,
      model: "m-a",
      occurredAt: sql`'2033-05-31T23:59:59.999999Z'::timestamptz`,
    },
    {
      projectId: alpha,
      provider: "openai" as const,
      model: "m-a",
      occurredAt: sql`'2033-06-04T00:00:00Z'::timestamptz`,
    },
  );
  const inserted = await db
    .insert(usageEvents)
    .values(rows.map((row) => ({ ...base, ...row })))
    .returning({ id: usageEvents.id });
  ids.push(...inserted.map((r) => r.id));
});

afterAll(async () => {
  // Deleting the projects cascades to their usage events.
  await db.delete(projects).where(inArray(projects.id, [alpha, beta]));
  await client.end();
});

async function allPages(filters: UsageFilters, pageSize: number) {
  const seen: string[] = [];
  const sizes: number[] = [];
  let cursor = filters.cursor;
  for (let guard = 0; guard < 50; guard++) {
    const page = await listUsageEvents(db, { ...filters, cursor }, pageSize);
    seen.push(...page.rows.map((r) => r.id));
    sizes.push(page.rows.length);
    if (!page.next) break;
    cursor = page.next;
  }
  return { seen, sizes };
}

describe("listUsageEvents", () => {
  it("returns the window newest first with project names", async () => {
    const { rows } = await listUsageEvents(db, window, 100);
    expect(rows).toHaveLength(12);
    expect(rows[0].projectName).toBe("Events Beta");
    expect(rows[0].occurredAt.toISOString()).toBe("2033-06-03T23:59:59.000Z");
    const times = rows.map((r) => r.occurredAt.getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it.each([1, 2, 3, 4, 7])(
    "pages through every row exactly once with page size %d",
    async (pageSize) => {
      const { seen, sizes } = await allPages(window, pageSize);
      expect(seen).toHaveLength(12);
      expect(new Set(seen).size).toBe(12);
      expect(sizes.slice(0, -1).every((s) => s === pageSize)).toBe(true);
      const { rows } = await listUsageEvents(db, window, 100);
      expect(seen).toEqual(rows.map((r) => r.id));
    },
  );

  it("keeps microsecond order that a JS Date would lose", async () => {
    const { seen } = await allPages({ ...window, projectId: alpha }, 1);
    // 8 alpha events in the window: two at 13:00 (µs apart), six at 12:00
    expect(seen).toHaveLength(8);
    expect(new Set(seen).size).toBe(8);
  });

  it("has no next cursor on the last page", async () => {
    expect((await listUsageEvents(db, window, 12)).next).toBeUndefined();
    expect((await listUsageEvents(db, window, 11)).next).toBeDefined();
  });

  it.each([
    [{ projectId: "beta" }, 4],
    [{ provider: "anthropic" as const }, 3],
    [{ model: "m-a" }, 9],
    [{ provider: "openai" as const, model: "m-c" }, 0],
    [{ from: "2033-06-02", to: "2033-06-02" }, 10],
    [{ from: "2033-06-03", to: "2033-06-03" }, 1],
  ])("filters by %o", async (extra, expected) => {
    const filters = {
      ...window,
      ...extra,
      projectId:
        "projectId" in extra
          ? extra.projectId === "beta"
            ? beta
            : alpha
          : undefined,
    };
    const { rows } = await listUsageEvents(db, filters, 100);
    expect(rows).toHaveLength(expected);
  });

  it("includes both ends of the date range", async () => {
    const { rows } = await listUsageEvents(db, window, 100);
    const times = rows.map((r) => r.occurredAt.toISOString());
    expect(times).toContain("2033-06-01T00:00:00.000Z");
    expect(times).toContain("2033-06-03T23:59:59.000Z");
    expect(ids).toHaveLength(14);
  });

  it.each([
    ["a project filter", "usage_events_project_occurred_idx"],
    ["no project filter", "usage_events_occurred_idx"],
  ])("can use an index with %s", async (label, index) => {
    const filters: UsageFilters = {
      ...window,
      projectId: label === "a project filter" ? alpha : undefined,
      cursor: { occurredAt: "2033-06-02T12:00:00.000000Z", id: ids[0] },
    };
    const query = usageEventsQuery(db, filters, 50).toSQL();
    // Tiny test tables make a sequential scan cheapest; turning it off
    // shows whether this query shape can use the index at all.
    const plan = await client.begin(async (tx) => {
      await tx.unsafe("set local enable_seqscan = off");
      return tx.unsafe(`explain ${query.sql}`, query.params as never[]);
    });
    const text = plan.map((row) => Object.values(row)[0]).join("\n");
    expect(text).toContain(index);
  });
});
