import "dotenv/config";
import { randomUUID } from "node:crypto";
import { count, eq, like } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { budgetStatus, budgetUtilization } from "@/lib/budget";
import { parseEnv } from "@/lib/env";
import { projects, usageEvents } from "../schema";
import { getSpendOverview } from "../spend";
import { generateDemoData } from "./generate";
import { loadDemoData, removeDemoData } from "./load";

// Runs against the database in DATABASE_URL after `npm run db:migrate`.
const client = postgres(parseEnv().DATABASE_URL, {
  max: 1,
  onnotice: () => {},
});
const db = drizzle(client);

// Years ahead, so demo spend never overlaps the real "today" other checks use.
const now = new Date("2035-06-20T12:00:00Z");
const data = generateDemoData({ now });

afterAll(async () => {
  await removeDemoData(db);
  await client.end();
});

async function demoCounts() {
  const [projectRows] = await db
    .select({ n: count() })
    .from(projects)
    .where(like(projects.slug, "demo-%"));
  const [eventRows] = await db
    .select({ n: count() })
    .from(usageEvents)
    .where(like(usageEvents.requestId, "demo-%"));
  return { projects: projectRows.n, events: eventRows.n };
}

describe("loadDemoData", () => {
  it("loads every project and event, and re-loading replaces rather than duplicates", async () => {
    const expected = {
      projects: data.projects.length,
      events: data.events.length,
    };
    expect(await loadDemoData(db, data)).toEqual(expected);
    expect(await demoCounts()).toEqual(expected);

    expect(await loadDemoData(db, data)).toEqual(expected);
    expect(await demoCounts()).toEqual(expected);
  });

  it("stores the generated costs and budgets exactly", async () => {
    const sample = data.events[Math.floor(data.events.length / 2)];
    const [stored] = await db
      .select()
      .from(usageEvents)
      .where(eq(usageEvents.requestId, sample.requestId));
    expect(stored.costUsd).toBe(sample.costUsd);
    expect(stored.cacheWriteInputTokens).toBe(sample.cacheWriteInputTokens);
    expect(stored.metadata).toEqual({ demo: true });

    const [support] = await db
      .select()
      .from(projects)
      .where(eq(projects.slug, "demo-support-bot"));
    expect(support.monthlyBudgetUsd).toBe(
      data.projects.find((p) => p.slug === "demo-support-bot")!
        .monthlyBudgetUsd,
    );
  });

  it("shows the intended budget states through the app's own overview query", async () => {
    const overview = await getSpendOverview(db, now);
    const states = Object.fromEntries(
      overview.projects
        .filter((p) => p.slug.startsWith("demo-"))
        .map((p) => [
          p.slug,
          budgetStatus(budgetUtilization(p.month, p.monthlyBudgetUsd)),
        ]),
    );
    expect(states).toEqual({
      "demo-support-bot": "warning",
      "demo-research-agent": "over",
      "demo-checkout-assistant": "ok",
      "demo-batch-summaries": "none",
    });
  });
});

describe("removeDemoData", () => {
  it("removes demo projects and their usage, and nothing else", async () => {
    const [keep] = await db
      .insert(projects)
      .values({ name: "Not demo", slug: `it-${randomUUID()}` })
      .returning();
    try {
      await loadDemoData(db, data);
      expect(await removeDemoData(db)).toBe(data.projects.length);
      expect(await demoCounts()).toEqual({ projects: 0, events: 0 });
      const [still] = await db
        .select()
        .from(projects)
        .where(eq(projects.id, keep.id));
      expect(still).toBeDefined();
    } finally {
      await db.delete(projects).where(eq(projects.id, keep.id));
    }
  });
});
