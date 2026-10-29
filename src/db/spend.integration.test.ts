import "dotenv/config";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseEnv } from "@/lib/env";
import { projects, usageEvents } from "./schema";
import { getSpendOverview } from "./spend";

// Runs against the database in DATABASE_URL after `npm run db:migrate`.
const client = postgres(parseEnv().DATABASE_URL, {
  max: 1,
  onnotice: () => {},
});
const db = drizzle(client);

// A "now" years ahead, so no other usage in the database falls in these
// windows and the overall totals can be checked exactly.
const now = new Date("2031-03-15T18:00:00Z");
const at = (iso: string) => new Date(iso);

let alpha: string;
let beta: string;
let idle: string;

beforeAll(async () => {
  const created = await db
    .insert(projects)
    .values([
      { name: "Spend Alpha", slug: `it-${randomUUID()}` },
      { name: "Spend Beta", slug: `it-${randomUUID()}` },
      { name: "Spend Idle", slug: `it-${randomUUID()}` },
    ])
    .returning({ id: projects.id });
  [alpha, beta, idle] = created.map((p) => p.id);

  const event = (projectId: string, occurredAt: Date, costUsd: string) => ({
    projectId,
    provider: "openai" as const,
    model: "spend-test",
    costUsd,
    occurredAt,
  });

  await db.insert(usageEvents).values([
    // Today (from 2031-03-15T00:00Z)
    event(alpha, at("2031-03-15T00:00:00Z"), "1.000001"),
    event(alpha, at("2031-03-15T17:59:59Z"), "2.000000"),
    // Earlier this month, also inside the last 30 days
    event(alpha, at("2031-03-14T23:59:59Z"), "0.100000"),
    event(beta, at("2031-03-01T00:00:00Z"), "5.000000"),
    // Last month: inside the last 30 days (from 2031-02-13T18:00Z) only
    event(beta, at("2031-02-28T23:59:59Z"), "0.300000"),
    event(beta, at("2031-02-13T18:00:00Z"), "0.040000"),
    // Outside every window
    event(beta, at("2031-02-13T17:59:59Z"), "100.000000"),
  ]);
});

afterAll(async () => {
  // Deleting the projects cascades to their usage events.
  await db.delete(projects).where(inArray(projects.id, [alpha, beta, idle]));
  await client.end();
});

describe("getSpendOverview", () => {
  it("sums each window exactly, including boundary timestamps", async () => {
    const overview = await getSpendOverview(db, now);

    expect(overview.totals).toEqual({
      today: "3.000001",
      month: "8.100001",
      last30Days: "8.440001",
      events: 6,
    });

    const byId = new Map(overview.projects.map((p) => [p.id, p]));
    expect(byId.get(alpha)).toMatchObject({
      today: "3.000001",
      month: "3.100001",
      last30Days: "3.100001",
      events: 3,
    });
    expect(byId.get(beta)).toMatchObject({
      today: "0.000000",
      month: "5.000000",
      last30Days: "5.340000",
      events: 3,
    });
  });

  it("lists projects without usage as zero", async () => {
    const overview = await getSpendOverview(db, now);
    expect(overview.projects.find((p) => p.id === idle)).toMatchObject({
      name: "Spend Idle",
      today: "0.000000",
      month: "0.000000",
      last30Days: "0.000000",
      events: 0,
    });
  });

  it("orders projects by this month's spend, highest first", async () => {
    const ids = (await getSpendOverview(db, now)).projects.map((p) => p.id);
    expect(ids.indexOf(beta)).toBeLessThan(ids.indexOf(alpha));
    expect(ids.indexOf(alpha)).toBeLessThan(ids.indexOf(idle));
  });

  it("returns zero totals when nothing falls in the windows", async () => {
    const overview = await getSpendOverview(
      db,
      new Date("2040-01-01T00:00:00Z"),
    );
    expect(overview.totals).toEqual({
      today: "0.000000",
      month: "0.000000",
      last30Days: "0.000000",
      events: 0,
    });
  });
});
