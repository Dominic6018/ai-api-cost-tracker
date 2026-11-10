import "dotenv/config";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseEnv } from "@/lib/env";
import type { ReserveRequest } from "@/lib/budget-reservations";
import type { UsageInput } from "@/lib/usage";
import { getBudgetCheckInputs } from "./budget-check";
import { endReservation, reserveBudget } from "./budget-reservations";
import { budgetReservations, modelPricing, projects } from "./schema";
import { recordUsage } from "./usage";

// Runs against the database in DATABASE_URL after `npm run db:migrate`.
// A pool, so concurrent reservations really run at the same time.
const client = postgres(parseEnv().DATABASE_URL, {
  max: 10,
  onnotice: () => {},
});
const db = drizzle(client);

const model = `it-reserve-${randomUUID()}`;
let projectId: string;
let priceId: string;

beforeAll(async () => {
  const [project] = await db
    .insert(projects)
    .values({
      name: "Reservations test",
      slug: `it-${randomUUID()}`,
      monthlyBudgetUsd: "1.00",
      runBudgetUsd: "0.30",
    })
    .returning();
  projectId = project.id;
  const [price] = await db
    .insert(modelPricing)
    .values({
      provider: "other",
      model,
      inputPerMTokUsd: "1",
      outputPerMTokUsd: "1",
      effectiveFrom: new Date("2026-01-01T00:00:00Z"),
    })
    .returning();
  priceId = price.id;
});

afterAll(async () => {
  // Deleting the project cascades to its reservations and usage.
  await db.delete(projects).where(eq(projects.id, projectId));
  await db.delete(modelPricing).where(eq(modelPricing.id, priceId));
  await client.end();
});

const request = (
  reservationId: string,
  usd: string,
  overrides: Partial<ReserveRequest> = {},
): ReserveRequest => ({
  reservationId,
  estimateMicros: BigInt(Math.round(Number(usd) * 1e6)),
  ttlSeconds: 600,
  ...overrides,
});

const usage = (overrides: Partial<UsageInput> = {}): UsageInput => ({
  projectId,
  provider: "other",
  model,
  inputTokens: 100_000,
  outputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  cacheWrite1hInputTokens: 0,
  serviceTier: "standard",
  webSearchRequests: 0,
  audioInputTokens: 0,
  cachedAudioInputTokens: 0,
  audioOutputTokens: 0,
  imageInputTokens: 0,
  cachedImageInputTokens: 0,
  imageOutputTokens: 0,
  occurredAt: new Date(),
  ...overrides,
});

describe("reserveBudget", () => {
  it("never lets concurrent holds exceed the budget", async () => {
    // Twenty $0.10 holds at once against the $1.00 monthly budget.
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        reserveBudget(db, projectId, request(`burst-${i}`, "0.10")),
      ),
    );
    const allowed = results.filter((r) => r.ok && r.reservation);
    expect(allowed).toHaveLength(10);
    expect(
      results.filter((r) => r.ok && !r.reservation && !r.decision.allowed),
    ).toHaveLength(10);
    const inputs = await getBudgetCheckInputs(db, projectId, undefined);
    expect(inputs?.monthHeldUsd).toBe("1.000000");

    // Releasing them frees the budget again.
    for (let i = 0; i < 20; i++) {
      await endReservation(db, {
        projectId,
        reservationId: `burst-${i}`,
        status: "released",
      });
    }
    expect(
      (await getBudgetCheckInputs(db, projectId, undefined))?.monthHeldUsd,
    ).toBe("0.000000");
  });

  it("checks the run budget, counting the run's holds", async () => {
    const first = await reserveBudget(
      db,
      projectId,
      request("run-a", "0.20", { runId: "run_x" }),
    );
    expect(first.ok && first.reservation?.status).toBe("held");
    const second = await reserveBudget(
      db,
      projectId,
      request("run-b", "0.20", { runId: "run_x" }),
    );
    expect(second.ok && second.decision.reasons).toEqual(["run_budget"]);
    // Another run isn't held back by run_x's hold.
    const other = await reserveBudget(
      db,
      projectId,
      request("run-c", "0.20", { runId: "run_y" }),
    );
    expect(other.ok && other.decision.allowed).toBe(true);
    for (const id of ["run-a", "run-c"]) {
      await endReservation(db, {
        projectId,
        reservationId: id,
        status: "released",
      });
    }
  });

  it("replays a reservation id, and refuses it for a different amount", async () => {
    const first = await reserveBudget(db, projectId, request("same", "0.05"));
    const again = await reserveBudget(db, projectId, request("same", "0.05"));
    expect(again.ok && again.replayed).toBe(true);
    expect(again.ok && again.reservation?.id).toBe(
      first.ok && first.reservation?.id,
    );
    expect(again.ok && again.decision.allowed).toBe(true);
    expect(await reserveBudget(db, projectId, request("same", "0.06"))).toEqual(
      {
        ok: false,
        error: "reservation_conflict",
      },
    );
    await endReservation(db, {
      projectId,
      reservationId: "same",
      status: "released",
    });
  });

  it("stops counting a hold once it expires", async () => {
    const at = new Date();
    await reserveBudget(
      db,
      projectId,
      request("short", "0.50", { ttlSeconds: 60 }),
      at,
    );
    const later = new Date(at.getTime() + 61_000);
    expect(
      (await getBudgetCheckInputs(db, projectId, undefined, at))?.monthHeldUsd,
    ).toBe("0.500000");
    expect(
      (await getBudgetCheckInputs(db, projectId, undefined, later))
        ?.monthHeldUsd,
    ).toBe("0.000000");
    // An expired hold can't be released or settled any more.
    const ended = await endReservation(db, {
      projectId,
      reservationId: "short",
      status: "released",
      now: later,
    });
    expect(ended?.status).toBe("held");
  });

  it("is settled by the usage recorded under it, once", async () => {
    await reserveBudget(db, projectId, request("step", "0.10"));
    const input = usage({
      reservationId: "step",
      requestId: `req-${randomUUID()}`,
    });
    const recorded = await recordUsage(db, input);
    expect(recorded.ok && recorded.event.costUsd).toBe("0.100000");
    const [row] = await db
      .select()
      .from(budgetReservations)
      .where(eq(budgetReservations.reservationKey, "step"));
    expect(row.status).toBe("settled");
    expect(row.endedAt).not.toBeNull();
    // A retry of the usage leaves it settled.
    await recordUsage(db, input);
    const [after] = await db
      .select()
      .from(budgetReservations)
      .where(eq(budgetReservations.reservationKey, "step"));
    expect(after.endedAt).toEqual(row.endedAt);
  });

  it("is undefined for an unknown project or reservation", async () => {
    expect(await reserveBudget(db, randomUUID(), request("x", "0.01"))).toEqual(
      { ok: false, error: "project_not_found" },
    );
    expect(
      await endReservation(db, {
        projectId,
        reservationId: "never-made",
        status: "released",
      }),
    ).toBeUndefined();
  });
});
