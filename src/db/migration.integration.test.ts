import "dotenv/config";
import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { parseEnv } from "@/lib/env";
import { modelPricing, projects, usageEvents } from "./schema";

// Runs against the database in DATABASE_URL after `npm run db:migrate`.
const client = postgres(parseEnv().DATABASE_URL, {
  max: 1,
  onnotice: () => {},
});
const db = drizzle(client);

const createdProjectIds: string[] = [];
const createdPricingIds: string[] = [];

afterAll(async () => {
  if (createdPricingIds.length > 0) {
    await db
      .delete(modelPricing)
      .where(inArray(modelPricing.id, createdPricingIds));
  }
  if (createdProjectIds.length > 0) {
    await db.delete(projects).where(inArray(projects.id, createdProjectIds));
  }
  await client.end();
});

/** Postgres SQLSTATE of a failed query; drizzle wraps driver errors in `cause`. */
async function pgErrorCode(
  query: Promise<unknown>,
): Promise<string | undefined> {
  try {
    await query;
  } catch (error) {
    const pgError = (error as { cause?: { code?: string } }).cause ?? error;
    return (pgError as { code?: string }).code;
  }
  throw new Error("Expected query to fail, but it succeeded");
}

const CHECK_VIOLATION = "23514";
const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";

async function createProject() {
  const slug = `it-${randomUUID()}`;
  const [project] = await db
    .insert(projects)
    .values({ name: "Integration test", slug })
    .returning();
  createdProjectIds.push(project.id);
  return project;
}

function usage(
  projectId: string,
  overrides: Partial<typeof usageEvents.$inferInsert> = {},
) {
  return {
    projectId,
    provider: "openai" as const,
    model: "test-model",
    inputTokens: 10,
    outputTokens: 5,
    costUsd: "0.000100",
    ...overrides,
  };
}

describe("initial migration", () => {
  it("creates every table and the provider enum", async () => {
    const tables = await db.execute<{ table_name: string }>(sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' ORDER BY table_name`);
    expect(tables.map((t) => t.table_name)).toEqual(
      expect.arrayContaining(["model_pricing", "projects", "usage_events"]),
    );

    const labels = await db.execute<{ label: string }>(sql`
      SELECT e.enumlabel AS label FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'provider' ORDER BY e.enumsortorder`);
    expect(labels.map((l) => l.label)).toEqual([
      "openai",
      "anthropic",
      "google",
      "mistral",
      "other",
    ]);
  });

  it("records the migration in the drizzle journal", async () => {
    const applied = await db.execute<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations`,
    );
    expect(Number(applied[0].count)).toBeGreaterThanOrEqual(1);
  });
});

describe("projects constraints", () => {
  it("enforces unique slugs", async () => {
    const project = await createProject();
    expect(
      await pgErrorCode(
        db.insert(projects).values({ name: "Duplicate", slug: project.slug }),
      ),
    ).toBe(UNIQUE_VIOLATION);
  });

  it("rejects a negative monthly budget but allows null and zero", async () => {
    expect(
      await pgErrorCode(
        db.insert(projects).values({
          name: "Negative budget",
          slug: `it-${randomUUID()}`,
          monthlyBudgetUsd: "-1.00",
        }),
      ),
    ).toBe(CHECK_VIOLATION);

    const [zero] = await db
      .insert(projects)
      .values({
        name: "Zero budget",
        slug: `it-${randomUUID()}`,
        monthlyBudgetUsd: "0",
      })
      .returning();
    createdProjectIds.push(zero.id);
    expect(zero.monthlyBudgetUsd).toBe("0.00");
  });
});

describe("model_pricing constraints", () => {
  it("rejects an effective_to that is not after effective_from", async () => {
    const at = new Date("2026-01-01T00:00:00Z");
    expect(
      await pgErrorCode(
        db.insert(modelPricing).values({
          provider: "anthropic",
          model: `it-${randomUUID()}`,
          inputPerMTokUsd: "3",
          outputPerMTokUsd: "15",
          effectiveFrom: at,
          effectiveTo: at,
        }),
      ),
    ).toBe(CHECK_VIOLATION);
  });

  it("enforces one price per provider, model, and effective_from", async () => {
    const values = {
      provider: "anthropic" as const,
      model: `it-${randomUUID()}`,
      inputPerMTokUsd: "3",
      outputPerMTokUsd: "15",
      effectiveFrom: new Date("2026-01-01T00:00:00Z"),
    };
    const [row] = await db.insert(modelPricing).values(values).returning();
    createdPricingIds.push(row.id);
    expect(await pgErrorCode(db.insert(modelPricing).values(values))).toBe(
      UNIQUE_VIOLATION,
    );
  });
});

describe("usage_events constraints", () => {
  it("rejects negative token counts", async () => {
    const project = await createProject();
    for (const field of [
      "inputTokens",
      "outputTokens",
      "cachedInputTokens",
    ] as const) {
      expect(
        await pgErrorCode(
          db.insert(usageEvents).values(usage(project.id, { [field]: -1 })),
        ),
      ).toBe(CHECK_VIOLATION);
    }
  });

  it("rejects events for unknown projects", async () => {
    expect(
      await pgErrorCode(db.insert(usageEvents).values(usage(randomUUID()))),
    ).toBe(FOREIGN_KEY_VIOLATION);
  });

  it("de-duplicates by provider and request_id but allows repeated null request_ids", async () => {
    const project = await createProject();
    const requestId = `req-${randomUUID()}`;

    await db.insert(usageEvents).values(usage(project.id, { requestId }));
    expect(
      await pgErrorCode(
        db.insert(usageEvents).values(usage(project.id, { requestId })),
      ),
    ).toBe(UNIQUE_VIOLATION);

    // Same request id from a different provider is a different request.
    await db
      .insert(usageEvents)
      .values(usage(project.id, { requestId, provider: "anthropic" }));

    await db.insert(usageEvents).values(usage(project.id));
    await db.insert(usageEvents).values(usage(project.id));

    const rows = await db
      .select()
      .from(usageEvents)
      .where(eq(usageEvents.projectId, project.id));
    expect(rows).toHaveLength(4);
  });

  it("cascades deletes from projects to usage events", async () => {
    const project = await createProject();
    await db.insert(usageEvents).values(usage(project.id));

    await db.delete(projects).where(eq(projects.id, project.id));

    const rows = await db
      .select()
      .from(usageEvents)
      .where(eq(usageEvents.projectId, project.id));
    expect(rows).toHaveLength(0);
  });

  it("stores cost_usd with six decimal places", async () => {
    const project = await createProject();
    const [row] = await db
      .insert(usageEvents)
      .values(usage(project.id, { costUsd: "1.2345678" }))
      .returning();
    expect(row.costUsd).toBe("1.234568");
  });
});
