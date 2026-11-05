import "dotenv/config";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseEnv } from "@/lib/env";
import { getBudgetCheckInputs } from "./budget-check";
import { projects, usageEvents } from "./schema";

// Runs against the database in DATABASE_URL after `npm run db:migrate`.
const client = postgres(parseEnv().DATABASE_URL, {
  max: 1,
  onnotice: () => {},
});
const db = drizzle(client);

// A month years ahead that only this test uses.
const now = new Date("2033-05-20T12:00:00Z");

let capped: string;
let uncapped: string;

beforeAll(async () => {
  const created = await db
    .insert(projects)
    .values([
      {
        name: "Budget check capped",
        slug: `it-${randomUUID()}`,
        monthlyBudgetUsd: "10.00",
        runBudgetUsd: "1.50",
      },
      { name: "Budget check uncapped", slug: `it-${randomUUID()}` },
    ])
    .returning({ id: projects.id });
  [capped, uncapped] = created.map((p) => p.id);

  const event = (
    projectId: string,
    occurredAt: string,
    costUsd: string,
    runId: string | null = null,
  ) => ({
    projectId,
    provider: "openai" as const,
    model: "budget-check-test",
    costUsd,
    occurredAt: new Date(occurredAt),
    runId,
  });
  await db.insert(usageEvents).values([
    // This month, from 2033-05-01T00:00Z
    event(capped, "2033-05-01T00:00:00Z", "1.000001", "run_a"),
    event(capped, "2033-05-19T08:00:00Z", "2.250000"),
    // Last month: not this month's spend, but still part of run_a
    event(capped, "2033-04-30T23:59:59Z", "0.400000", "run_a"),
    // The same run ID in another project doesn't count
    event(uncapped, "2033-05-02T00:00:00Z", "5.000000", "run_a"),
  ]);
});

afterAll(async () => {
  // Deleting the projects cascades to their usage events.
  await db.delete(projects).where(inArray(projects.id, [capped, uncapped]));
  await client.end();
});

describe("getBudgetCheckInputs", () => {
  it("reads the caps, this month's spend and the run's total", async () => {
    expect(await getBudgetCheckInputs(db, capped, "run_a", now)).toEqual({
      monthlyBudgetUsd: "10.00",
      runBudgetUsd: "1.50",
      monthSpentUsd: "3.250001",
      runSpentUsd: "1.400001",
    });
  });

  it("leaves the run out without a run ID, and is zero for a new run", async () => {
    expect(
      await getBudgetCheckInputs(db, capped, undefined, now),
    ).toMatchObject({ monthSpentUsd: "3.250001", runSpentUsd: null });
    expect(
      (await getBudgetCheckInputs(db, capped, "run_new", now))?.runSpentUsd,
    ).toBe("0.000000");
  });

  it("returns null caps for a project without budgets", async () => {
    expect(await getBudgetCheckInputs(db, uncapped, "run_a", now)).toEqual({
      monthlyBudgetUsd: null,
      runBudgetUsd: null,
      monthSpentUsd: "5.000000",
      runSpentUsd: "5.000000",
    });
  });

  it("starts the month's spend again in a new month", async () => {
    const june = new Date("2033-06-01T00:00:00Z");
    expect(
      (await getBudgetCheckInputs(db, capped, undefined, june))?.monthSpentUsd,
    ).toBe("0.000000");
  });

  it("is undefined for a project that doesn't exist", async () => {
    expect(
      await getBudgetCheckInputs(db, randomUUID(), undefined, now),
    ).toBeUndefined();
  });

  it("treats a run ID as data, not SQL", async () => {
    expect(
      (await getBudgetCheckInputs(db, capped, "x' OR '1'='1", now))
        ?.runSpentUsd,
    ).toBe("0.000000");
  });
});
