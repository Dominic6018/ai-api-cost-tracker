import "dotenv/config";
import { randomUUID } from "node:crypto";
import { asc, eq, like } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseEnv } from "@/lib/env";
import type { PriceInput } from "@/lib/price-form";
import {
  addModelPrice,
  findEffectivePricing,
  listModelPrices,
} from "./pricing";
import { modelPricing, users } from "./schema";

// Runs against the database in DATABASE_URL after `npm run db:migrate`.
const client = postgres(parseEnv().DATABASE_URL, {
  max: 1,
  onnotice: () => {},
});
const db = drizzle(client);

// Unique per run so tests never collide with real or leftover pricing rows.
const prefix = `it-price-admin-${randomUUID().slice(0, 8)}`;
let userId: string;
const email = `${prefix}@example.com`;

beforeAll(async () => {
  const [user] = await db
    .insert(users)
    .values({ email, passwordHash: "not-a-real-hash" })
    .returning({ id: users.id });
  userId = user.id;
});

afterAll(async () => {
  await db.delete(modelPricing).where(like(modelPricing.model, `${prefix}%`));
  await db.delete(users).where(eq(users.id, userId));
  await client.end();
});

const at = (iso: string) => new Date(iso);

const input = (model: string, from: string): PriceInput => ({
  provider: "openai",
  model,
  inputPerMTokUsd: "2",
  outputPerMTokUsd: "8",
  cachedInputPerMTokUsd: "0.5",
  cacheWritePerMTokUsd: null,
  longContextThresholdTokens: null,
  longInputPerMTokUsd: null,
  longOutputPerMTokUsd: null,
  longCachedInputPerMTokUsd: null,
  longCacheWritePerMTokUsd: null,
  effectiveFrom: at(from),
  sourceUrl: "https://developers.openai.com/api/docs/pricing",
  checkedOn: "2026-11-06",
});

/** Seeds an existing price, as `npm run db:seed` would. */
async function existing(model: string, from: string, to: string | null = null) {
  await db.insert(modelPricing).values({
    provider: "openai",
    model,
    inputPerMTokUsd: "3",
    outputPerMTokUsd: "12",
    effectiveFrom: at(from),
    effectiveTo: to ? at(to) : null,
  });
}

const history = (model: string) =>
  db
    .select({
      from: modelPricing.effectiveFrom,
      to: modelPricing.effectiveTo,
      input: modelPricing.inputPerMTokUsd,
      recordedBy: modelPricing.recordedBy,
    })
    .from(modelPricing)
    .where(eq(modelPricing.model, model))
    .orderBy(asc(modelPricing.effectiveFrom));

describe("addModelPrice", () => {
  it("ends the price in effect where the new one starts", async () => {
    const model = `${prefix}-a`;
    await existing(model, "2026-01-01T00:00:00Z");

    const result = await addModelPrice(
      db,
      input(model, "2026-03-01T00:00:00Z"),
      userId,
    );
    expect(result).toMatchObject({ ok: true, ended: 1 });
    expect(result.ok && result.price).toMatchObject({
      sourceUrl: "https://developers.openai.com/api/docs/pricing",
      checkedOn: "2026-11-06",
      cachedInputPerMTokUsd: "0.500000",
      recordedBy: userId,
    });
    expect(await history(model)).toEqual([
      {
        from: at("2026-01-01T00:00:00Z"),
        to: at("2026-03-01T00:00:00Z"),
        input: "3.000000",
        recordedBy: null,
      },
      {
        from: at("2026-03-01T00:00:00Z"),
        to: null,
        input: "2.000000",
        recordedBy: userId,
      },
    ]);

    // The cost lookup switches at the new start.
    const lookup = (iso: string) =>
      findEffectivePricing(db, { provider: "openai", model, at: at(iso) });
    const before = await lookup("2026-02-28T23:59:59Z");
    const after = await lookup("2026-03-01T00:00:00Z");
    expect(before.found && before.row.inputPerMTokUsd).toBe("3.000000");
    expect(after.found && after.row.inputPerMTokUsd).toBe("2.000000");
  });

  it("ends before an already scheduled price and leaves it alone", async () => {
    const model = `${prefix}-b`;
    await existing(model, "2026-01-01T00:00:00Z");
    await existing(model, "2026-06-01T00:00:00Z");

    const result = await addModelPrice(
      db,
      input(model, "2026-03-01T00:00:00Z"),
      userId,
    );
    expect(result).toMatchObject({ ok: true, ended: 1 });
    expect((await history(model)).map((r) => [r.from, r.to])).toEqual([
      [at("2026-01-01T00:00:00Z"), at("2026-03-01T00:00:00Z")],
      [at("2026-03-01T00:00:00Z"), at("2026-06-01T00:00:00Z")],
      [at("2026-06-01T00:00:00Z"), null],
    ]);
  });

  it("leaves a price that already ended before the new start", async () => {
    const model = `${prefix}-c`;
    await existing(model, "2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z");

    const result = await addModelPrice(
      db,
      input(model, "2026-03-01T00:00:00Z"),
      userId,
    );
    expect(result).toMatchObject({ ok: true, ended: 0 });
    expect((await history(model))[0].to).toEqual(at("2026-02-01T00:00:00Z"));
  });

  it("adds the first price for a new model", async () => {
    const model = `${prefix}-d`;
    expect(
      await addModelPrice(db, input(model, "2026-03-01T00:00:00Z"), userId),
    ).toMatchObject({ ok: true, ended: 0 });
    expect(await history(model)).toHaveLength(1);
  });

  it("refuses a duplicate start and changes nothing", async () => {
    const model = `${prefix}-e`;
    await existing(model, "2026-01-01T00:00:00Z");
    await existing(model, "2026-03-01T00:00:00Z");
    const before = await history(model);

    expect(
      await addModelPrice(db, input(model, "2026-03-01T00:00:00Z"), userId),
    ).toEqual({ ok: false, error: "duplicate_start" });
    // The first price would have been ended inside the same transaction.
    expect(await history(model)).toEqual(before);
  });

  it("lists who added each price, and keeps the price if they're deleted", async () => {
    const model = `${prefix}-f`;
    const [other] = await db
      .insert(users)
      .values({ email: `${prefix}-f@example.com`, passwordHash: "x" })
      .returning({ id: users.id });
    await addModelPrice(db, input(model, "2026-03-01T00:00:00Z"), other.id);

    const listed = (await listModelPrices(db)).find((p) => p.model === model);
    expect(listed).toMatchObject({
      recordedBy: other.id,
      recordedByEmail: `${prefix}-f@example.com`,
    });

    await db.delete(users).where(eq(users.id, other.id));
    const [row] = await history(model);
    expect(row).toMatchObject({ input: "2.000000", recordedBy: null });
  });
});
