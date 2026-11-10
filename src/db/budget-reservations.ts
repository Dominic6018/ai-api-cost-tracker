import { and, eq, gt } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { TablesRelationalConfig } from "drizzle-orm/relations";
import {
  decideBudgetCheck,
  microsToDecimal,
  type BudgetCheckResult,
} from "@/lib/budget-check";
import type { ReserveRequest } from "@/lib/budget-reservations";
import { getBudgetCheckInputs } from "./budget-check";
import { budgetReservations, projects, type BudgetReservation } from "./schema";

export type ReserveResult =
  | {
      ok: true;
      decision: BudgetCheckResult;
      /** The hold, or null when the request was denied. */
      reservation: BudgetReservation | null;
      /** True when this reservation id was already used. */
      replayed: boolean;
    }
  | { ok: false; error: "project_not_found" | "reservation_conflict" };

/**
 * Holds part of the project's budgets for a step, if it fits. The
 * project's row is locked for the length of the transaction, so concurrent
 * reservations for one project are decided one after another, each seeing
 * the holds before it. Spend counts recorded usage plus unexpired holds.
 *
 * A reservation id is the caller's, unique per project: repeating it
 * returns the existing hold, and repeating it for a different amount or
 * run is a conflict.
 */
export async function reserveBudget<
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
>(
  db: Pick<PgDatabase<TQueryResult, TFullSchema, TSchema>, "transaction">,
  projectId: string,
  request: ReserveRequest,
  now: Date = new Date(),
): Promise<ReserveResult> {
  return db.transaction(async (tx) => {
    const [project] = await tx
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, projectId))
      .for("update");
    if (!project) return { ok: false, error: "project_not_found" } as const;

    const [existing] = await tx
      .select()
      .from(budgetReservations)
      .where(
        and(
          eq(budgetReservations.projectId, projectId),
          eq(budgetReservations.reservationKey, request.reservationId),
        ),
      );
    const inputs = await getBudgetCheckInputs(
      tx,
      projectId,
      request.runId,
      now,
    );
    if (!inputs) return { ok: false, error: "project_not_found" } as const;

    if (existing) {
      const same =
        existing.amountUsd === microsToDecimal(request.estimateMicros) &&
        (existing.runId ?? undefined) === request.runId;
      if (!same) return { ok: false, error: "reservation_conflict" } as const;
      // The hold already counts in `inputs`; report the budgets as they are.
      const held = existing.status === "held" && existing.expiresAt > now;
      return {
        ok: true,
        decision: {
          ...decideBudgetCheck(
            { estimateMicros: 0n, runId: request.runId },
            inputs,
            now,
          ),
          allowed: held,
          reasons: [],
          estimatedCostUsd: existing.amountUsd,
        },
        reservation: existing,
        replayed: true,
      } as const;
    }

    const decision = decideBudgetCheck(request, inputs, now);
    if (!decision.allowed) {
      return {
        ok: true,
        decision,
        reservation: null,
        replayed: false,
      } as const;
    }
    const [reservation] = await tx
      .insert(budgetReservations)
      .values({
        projectId,
        reservationKey: request.reservationId,
        runId: request.runId ?? null,
        amountUsd: microsToDecimal(request.estimateMicros),
        expiresAt: new Date(now.getTime() + request.ttlSeconds * 1000),
        createdAt: now,
      })
      .returning();
    return { ok: true, decision, reservation, replayed: false } as const;
  });
}

/**
 * Ends a hold early: "released" when the step didn't spend, "settled"
 * when its usage has been recorded. Only a hold that's still held changes,
 * so this is safe to repeat. Returns the reservation as it now is.
 */
export async function endReservation(
  db: Pick<PgDatabase<PgQueryResultHKT>, "select" | "update">,
  {
    projectId,
    reservationId,
    status,
    now = new Date(),
  }: {
    projectId: string;
    reservationId: string;
    status: "released" | "settled";
    now?: Date;
  },
): Promise<BudgetReservation | undefined> {
  const match = and(
    eq(budgetReservations.projectId, projectId),
    eq(budgetReservations.reservationKey, reservationId),
  );
  const [ended] = await db
    .update(budgetReservations)
    .set({ status, endedAt: now })
    .where(
      and(
        match,
        eq(budgetReservations.status, "held"),
        gt(budgetReservations.expiresAt, now),
      ),
    )
    .returning();
  if (ended) return ended;
  const [current] = await db.select().from(budgetReservations).where(match);
  return current;
}
