import "dotenv/config";
import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { parseEnv } from "@/lib/env";
import { findEffectivePricing } from "../pricing";
import { modelPricing, projects } from "../schema";
import { sampleProjects, seedPrices } from "./data";
import { seed } from "./seed";

// Runs against the database in DATABASE_URL after `npm run db:migrate`.
// Seed rows are left in place afterwards, as `npm run db:seed` would.
const client = postgres(parseEnv().DATABASE_URL, {
  max: 1,
  onnotice: () => {},
});
const db = drizzle(client);

afterAll(async () => {
  await client.end();
});

async function countSeedPrices() {
  const rows = await db
    .select({ id: modelPricing.id })
    .from(modelPricing)
    .where(
      inArray(
        modelPricing.model,
        seedPrices.map((p) => p.model),
      ),
    );
  return rows.length;
}

describe("seed", () => {
  it("inserts every seed row and is a no-op when re-run", async () => {
    await seed(db);
    expect(await countSeedPrices()).toBe(seedPrices.length);

    const rerun = await seed(db);
    expect(rerun).toEqual({ projectsInserted: 0, pricesInserted: 0 });
    expect(await countSeedPrices()).toBe(seedPrices.length);
  });

  it("creates the sample projects", async () => {
    const rows = await db
      .select()
      .from(projects)
      .where(
        inArray(
          projects.slug,
          sampleProjects.map((p) => p.slug),
        ),
      );
    expect(rows).toHaveLength(sampleProjects.length);
  });

  it("does not overwrite an existing price", async () => {
    const [first] = seedPrices;
    const match = and(
      eq(modelPricing.provider, first.provider),
      eq(modelPricing.model, first.model),
      eq(modelPricing.effectiveFrom, new Date(first.effectiveFrom)),
    );
    const [before] = await db.select().from(modelPricing).where(match);

    await seed(db);

    const [after] = await db.select().from(modelPricing).where(match);
    expect(after).toEqual(before);
  });

  it("follows a scheduled price change through the pricing lookup", async () => {
    const before = await findEffectivePricing(db, {
      provider: "google",
      model: "gemini-3.8-flash",
      at: new Date("2026-12-31T23:59:59Z"),
    });
    const after = await findEffectivePricing(db, {
      provider: "google",
      model: "gemini-3.8-flash",
      at: new Date("2027-01-01T00:00:00Z"),
    });
    expect(before.found && before.pricing.inputPerMTokUsd).toBe(0.75);
    expect(after.found && after.pricing.inputPerMTokUsd).toBe(1.5);
  });
});
