import "dotenv/config";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { parseEnv } from "@/lib/env";
import { explainSpendChange } from "@/lib/spend-change";
import { organizations, projects, usageEvents } from "./schema";
import { ALL_ORGANIZATIONS } from "./scope";
import { getSpendChangeInputs } from "./spend-change";

// Runs against the database in DATABASE_URL after `npm run db:migrate`.
const client = postgres(parseEnv().DATABASE_URL, {
  max: 1,
  onnotice: () => {},
});
const db = drizzle(client);

const organizationIds: string[] = [];

afterAll(async () => {
  if (organizationIds.length > 0) {
    await db
      .delete(projects)
      .where(inArray(projects.organizationId, organizationIds));
    await db
      .delete(organizations)
      .where(inArray(organizations.id, organizationIds));
  }
  await client.end();
});

const periods = {
  before: {
    from: new Date("2026-09-01T00:00:00Z"),
    to: new Date("2026-10-01T00:00:00Z"),
  },
  after: {
    from: new Date("2026-10-01T00:00:00Z"),
    to: new Date("2026-11-01T00:00:00Z"),
  },
};

async function setup() {
  const [organization] = await db
    .insert(organizations)
    .values({ name: "Spend change test", slug: `it-${randomUUID()}` })
    .returning();
  organizationIds.push(organization.id);
  const [a, b] = await db
    .insert(projects)
    .values(
      ["a", "b"].map((s) => ({
        organizationId: organization.id,
        name: `Project ${s}`,
        slug: `it-${s}-${randomUUID()}`,
      })),
    )
    .returning();
  const usage = (
    projectId: string,
    model: string,
    occurredAt: string,
    costUsd: string | null,
    inputTokens = 900,
    outputTokens = 100,
  ) =>
    db.insert(usageEvents).values({
      projectId,
      provider: "openai",
      model,
      inputTokens,
      outputTokens,
      costUsd,
      pricingStatus: costUsd === null ? "unpriced" : "priced",
      unpricedReason: costUsd === null ? "no_pricing" : null,
      occurredAt: new Date(occurredAt),
    });
  return { scope: { organizationId: organization.id }, a, b, usage };
}

describe("getSpendChangeInputs", () => {
  it("sums each model's priced usage in each period", async () => {
    const t = await setup();
    await t.usage(t.a.id, "gpt-4.1", "2026-09-01T00:00:00Z", "1.000000");
    await t.usage(t.b.id, "gpt-4.1", "2026-09-30T23:59:59Z", "1.000000");
    await t.usage(
      t.a.id,
      "gpt-4.1",
      "2026-10-15T00:00:00Z",
      "2.500000",
      1800,
      200,
    );
    await t.usage(t.a.id, "gpt-4.1-mini", "2026-10-31T23:59:59Z", "0.250000");
    // Outside both periods, unpriced, or in another organization.
    await t.usage(t.a.id, "gpt-4.1", "2026-08-31T23:59:59Z", "50");
    await t.usage(t.a.id, "gpt-4.1", "2026-11-01T00:00:00Z", "50");
    await t.usage(t.a.id, "gpt-4.1", "2026-10-02T00:00:00Z", null);
    const elsewhere = await setup();
    await elsewhere.usage(
      elsewhere.a.id,
      "gpt-4.1",
      "2026-10-02T00:00:00Z",
      "50",
    );

    const inputs = await getSpendChangeInputs(db, t.scope, periods);
    expect(inputs.unpriced).toEqual({ before: 0, after: 1 });
    const byModel = Object.fromEntries(inputs.models.map((m) => [m.model, m]));
    expect(byModel["gpt-4.1"]).toEqual({
      provider: "openai",
      model: "gpt-4.1",
      before: { requests: 2n, tokens: 2000n, costMicros: 2_000_000n },
      after: { requests: 1n, tokens: 2000n, costMicros: 2_500_000n },
    });
    expect(byModel["gpt-4.1-mini"]).toMatchObject({
      before: null,
      after: { requests: 1n, tokens: 1000n, costMicros: 250_000n },
    });
    expect(inputs.models).toHaveLength(2);

    const result = explainSpendChange(inputs.models);
    expect(result).toMatchObject({
      beforeMicros: 2_000_000n,
      afterMicros: 2_750_000n,
      changeMicros: 750_000n,
    });
  });

  it("can be limited to one project", async () => {
    const t = await setup();
    await t.usage(t.a.id, "gpt-4.1", "2026-09-10T00:00:00Z", "1");
    await t.usage(t.b.id, "gpt-4.1", "2026-10-10T00:00:00Z", "3");
    const onlyB = await getSpendChangeInputs(db, t.scope, periods, t.b.id);
    expect(onlyB.models).toEqual([
      {
        provider: "openai",
        model: "gpt-4.1",
        before: null,
        after: { requests: 1n, tokens: 1000n, costMicros: 3_000_000n },
      },
    ]);
    // A project from another organization finds nothing.
    const other = await setup();
    expect(
      (await getSpendChangeInputs(db, other.scope, periods, t.b.id)).models,
    ).toEqual([]);
    // Without an organization, every organization counts.
    const all = await getSpendChangeInputs(db, ALL_ORGANIZATIONS, periods);
    expect(all.models.length).toBeGreaterThan(0);
  });
});
