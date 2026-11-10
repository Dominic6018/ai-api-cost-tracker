import type { ReserveResult } from "@/db/budget-reservations";
import type { BudgetReservation } from "@/db/schema";
import {
  parseReleasePayload,
  parseReservePayload,
  type ReserveRequest,
} from "@/lib/budget-reservations";
import { authorizeApiKey, errorResponse, type ApiKeyDeps } from "../authorize";

/** Largest accepted request body. */
export const MAX_BODY_BYTES = 4 * 1024;

export interface ReservationHandlerDeps extends ApiKeyDeps {
  reserve: (
    projectId: string,
    request: ReserveRequest,
    now: Date,
  ) => Promise<ReserveResult>;
  release: (
    projectId: string,
    reservationId: string,
    now: Date,
  ) => Promise<BudgetReservation | undefined>;
}

/** A reservation as the API shows it; amounts are exact decimal strings. */
export function reservationJson(reservation: BudgetReservation, now: Date) {
  const lapsed = reservation.status === "held" && reservation.expiresAt <= now;
  return {
    reservationId: reservation.reservationKey,
    amountUsd: reservation.amountUsd,
    runId: reservation.runId,
    // A hold past its expiry no longer counts; report it as expired.
    status: lapsed ? ("expired" as const) : reservation.status,
    expiresAt: reservation.expiresAt.toISOString(),
  };
}

/** Reads a small JSON body, or returns the error response. */
async function readJson(
  request: Request,
): Promise<{ ok: true; body: unknown } | { ok: false; response: Response }> {
  const tooLarge = () => ({
    ok: false as const,
    response: errorResponse(413, "payload_too_large", "Request body too large"),
  });
  if (Number(request.headers.get("content-length")) > MAX_BODY_BYTES) {
    return tooLarge();
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return tooLarge();
  try {
    return { ok: true, body: JSON.parse(text) };
  } catch {
    return {
      ok: false,
      response: errorResponse(400, "invalid_json", "Request body must be JSON"),
    };
  }
}

const noStore = { headers: { "cache-control": "no-store" } };

/** `POST /api/budget/reserve`: hold part of the budgets for a step. */
export function createReserveHandler(deps: ReservationHandlerDeps) {
  const now = () => deps.now?.() ?? new Date();
  return async function handleReserve(request: Request): Promise<Response> {
    const auth = await authorizeApiKey(request, deps);
    if (!auth.ok) return auth.response;
    const read = await readJson(request);
    if (!read.ok) return read.response;
    const parsed = parseReservePayload(read.body);
    if (!parsed.ok) {
      return errorResponse(400, "invalid_payload", "Invalid reservation", {
        fieldErrors: parsed.fieldErrors,
        formErrors: parsed.formErrors,
      });
    }
    const at = now();
    const result = await deps.reserve(auth.projectId, parsed.request, at);
    if (!result.ok) {
      return result.error === "project_not_found"
        ? errorResponse(404, "project_not_found", "Project not found")
        : errorResponse(
            409,
            "reservation_conflict",
            "This reservationId was already used for a different amount or run",
          );
    }
    // A denial is an answer, not an error, as for the budget check.
    return Response.json(
      {
        ...result.decision,
        reservation: result.reservation
          ? reservationJson(result.reservation, at)
          : null,
        replayed: result.replayed,
      },
      noStore,
    );
  };
}

/** `POST /api/budget/release`: end a hold whose step didn't spend. */
export function createReleaseHandler(deps: ReservationHandlerDeps) {
  const now = () => deps.now?.() ?? new Date();
  return async function handleRelease(request: Request): Promise<Response> {
    const auth = await authorizeApiKey(request, deps);
    if (!auth.ok) return auth.response;
    const read = await readJson(request);
    if (!read.ok) return read.response;
    const parsed = parseReleasePayload(read.body);
    if (!parsed.ok) {
      return errorResponse(400, "invalid_payload", "Invalid release", {
        fieldErrors: parsed.fieldErrors,
        formErrors: parsed.formErrors,
      });
    }
    const at = now();
    const reservation = await deps.release(
      auth.projectId,
      parsed.request.reservationId,
      at,
    );
    if (!reservation) {
      return errorResponse(
        404,
        "reservation_not_found",
        "No reservation with this reservationId in this project",
      );
    }
    return Response.json(
      { reservation: reservationJson(reservation, at) },
      noStore,
    );
  };
}
