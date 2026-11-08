import "dotenv/config";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseEnv } from "@/lib/env";
import {
  listOutcomeNames,
  outcomeCountsByAttribution,
  recordOutcome,
} from "./outcomes";
import { outcomes, projects } from "./schema";
import { ALL_ORGANIZATIONS } from "./scope";

// Runs against the database in DATABASE_URL after `npm run db:migrate`.
const client = postgres(parseEnv().DATABASE_URL, {
  max: 1,
  onnotice: () => {},
});
const db = drizzle(client);

let projectId: string;
let otherProjectId: string;
const at = new Date("2037-05-02T00:00:00Z");

beforeAll(async () => {
  const created = await db
    .insert(projects)
    .values([
      { name: "Outcomes", slug: `it-${randomUUID()}` },
      { name: "Outcomes other", slug: `it-${randomUUID()}` },
    ])
    .returning({ id: projects.id });
  [projectId, otherProjectId] = created.map((p) => p.id);
});

afterAll(async () => {
  await db
    .delete(projects)
    .where(inArray(projects.id, [projectId, otherProjectId]));
  await client.end();
});

const outcome = (overrides: Record<string, unknown> = {}) => ({
  projectId,
  name: "ticket_resolved",
  count: 1,
  occurredAt: at,
  ...overrides,
});

describe("recordOutcome", () => {
  it("stores an outcome with its attribution", async () => {
    const result = await recordOutcome(
      db,
      outcome({ customerId: "acme", feature: "chat", count: 3 }),
    );
    if (!result.ok) throw new Error(result.error);
    expect(result.outcome).toMatchObject({
      name: "ticket_resolved",
      count: 3,
      customerId: "acme",
      feature: "chat",
      userId: null,
    });
  });

  it("replays a retry with the same outcomeId instead of counting twice", async () => {
    const outcomeId = `t-${randomUUID()}`;
    const first = await recordOutcome(db, outcome({ outcomeId }));
    const second = await recordOutcome(db, outcome({ outcomeId }));
    if (!first.ok || !second.ok) throw new Error("expected success");
    expect(second.replayed).toBe(true);
    expect(second.outcome.id).toBe(first.outcome.id);
    const rows = await db
      .select()
      .from(outcomes)
      .where(eq(outcomes.outcomeId, outcomeId));
    expect(rows).toHaveLength(1);
  });

  it("returns a conflict when the outcomeId describes something else", async () => {
    const outcomeId = `t-${randomUUID()}`;
    await recordOutcome(db, outcome({ outcomeId }));
    expect(await recordOutcome(db, outcome({ outcomeId, count: 2 }))).toEqual({
      ok: false,
      error: "outcome_id_conflict",
    });
  });

  it("keeps outcomeIds separate per project", async () => {
    const outcomeId = `t-${randomUUID()}`;
    const mine = await recordOutcome(db, outcome({ outcomeId }));
    const theirs = await recordOutcome(
      db,
      outcome({ outcomeId, projectId: otherProjectId }),
    );
    expect(mine.ok && theirs.ok && !theirs.replayed).toBe(true);
  });

  it("stores one outcome when identical retries race", async () => {
    const outcomeId = `t-${randomUUID()}`;
    const pool = postgres(parseEnv().DATABASE_URL, {
      max: 5,
      onnotice: () => {},
    });
    try {
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          recordOutcome(drizzle(pool), outcome({ outcomeId })),
        ),
      );
      expect(results.every((r) => r.ok)).toBe(true);
      expect(results.filter((r) => r.ok && !r.replayed)).toHaveLength(1);
    } finally {
      await pool.end();
    }
  });

  it("returns project_not_found for an unknown project", async () => {
    expect(
      await recordOutcome(db, outcome({ projectId: randomUUID() })),
    ).toEqual({ ok: false, error: "project_not_found" });
  });
});

describe("outcome queries", () => {
  // A window of its own, after the rows above.
  const later = new Date("2037-08-01T00:00:00Z");

  beforeAll(async () => {
    const day = new Date("2037-08-02T00:00:00Z");
    for (const values of [
      { customerId: "acme", count: 4 },
      { customerId: "acme", count: 2 },
      { customerId: "globex", count: 1 },
      { count: 5 },
      { name: "order_completed", customerId: "acme", count: 9 },
      { customerId: "acme", count: 7, projectId: otherProjectId },
    ]) {
      await recordOutcome(db, outcome({ occurredAt: day, ...values }));
    }
  });

  it("sums one outcome's counts per attribution value", async () => {
    const counts = await outcomeCountsByAttribution(db, ALL_ORGANIZATIONS, {
      key: "customerId",
      name: "ticket_resolved",
      start: later,
      projectId,
    });
    expect(Object.fromEntries(counts.byValue)).toEqual({
      acme: 6,
      globex: 1,
      null: 5,
    });
    expect(counts.total).toBe(12);
  });

  it("covers every project when none is given", async () => {
    const counts = await outcomeCountsByAttribution(db, ALL_ORGANIZATIONS, {
      key: "customerId",
      name: "ticket_resolved",
      start: later,
    });
    expect(counts.byValue.get("acme")).toBe(13);
  });

  it("lists the outcome names in a range", async () => {
    expect(
      await listOutcomeNames(db, ALL_ORGANIZATIONS, {
        start: later,
        projectId,
      }),
    ).toEqual(["order_completed", "ticket_resolved"]);
  });
});
