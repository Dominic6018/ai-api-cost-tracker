/**
 * Budget reservations: hold part of a budget before a step spends it, so
 * steps checked at the same moment can't each be allowed past the cap.
 */

import { z } from "zod";
import { MAX_ATTRIBUTION_LENGTH } from "./attribution";
import { budgetCheckPayloadSchema } from "./budget-check";

/** How long a hold lasts by default, and at most, before it lapses. */
export const DEFAULT_RESERVATION_TTL_SECONDS = 10 * 60;
export const MAX_RESERVATION_TTL_SECONDS = 24 * 60 * 60;

/** The caller's id for a hold, unique per project; retries reuse it. */
const reservationId = z.string().trim().min(1).max(MAX_ATTRIBUTION_LENGTH);

/** Body of `POST /api/budget/reserve`. */
export const reservePayloadSchema = budgetCheckPayloadSchema
  .extend({
    reservationId,
    ttlSeconds: z
      .number()
      .int()
      .min(1)
      .max(MAX_RESERVATION_TTL_SECONDS)
      .default(DEFAULT_RESERVATION_TTL_SECONDS),
  })
  .strict();

/** Body of `POST /api/budget/release`. */
export const releasePayloadSchema = z.object({ reservationId }).strict();

export interface ReserveRequest {
  reservationId: string;
  estimateMicros: bigint;
  runId?: string;
  ttlSeconds: number;
}

export type ParseResult<T> =
  | { ok: true; request: T }
  | { ok: false; fieldErrors: Record<string, string[]>; formErrors: string[] };

function failure(error: z.ZodError) {
  const { fieldErrors, formErrors } = z.flattenError(error);
  return {
    ok: false as const,
    fieldErrors: fieldErrors as Record<string, string[]>,
    formErrors,
  };
}

export function parseReservePayload(
  body: unknown,
): ParseResult<ReserveRequest> {
  const result = reservePayloadSchema.safeParse(body);
  if (!result.success) return failure(result.error);
  // An estimate is what a reservation holds, so it's required.
  if (result.data.estimatedCostUsd === undefined) {
    return {
      ok: false,
      fieldErrors: { estimatedCostUsd: ["Required: the amount to hold"] },
      formErrors: [],
    };
  }
  return {
    ok: true,
    request: {
      reservationId: result.data.reservationId,
      estimateMicros: result.data.estimatedCostUsd,
      ttlSeconds: result.data.ttlSeconds,
      ...(result.data.runId && { runId: result.data.runId }),
    },
  };
}

export function parseReleasePayload(
  body: unknown,
): ParseResult<{ reservationId: string }> {
  const result = releasePayloadSchema.safeParse(body);
  return result.success
    ? { ok: true, request: result.data }
    : failure(result.error);
}
