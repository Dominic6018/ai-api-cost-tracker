import { db } from "@/db";
import { authenticateApiKey } from "@/db/api-keys";
import { endReservation, reserveBudget } from "@/db/budget-reservations";
import { hitRateLimit } from "@/db/rate-limits";
import { RATE_LIMITS, rateLimitKey } from "@/lib/rate-limit";
import type { ReservationHandlerDeps } from "./reservations";

export const reservationDeps: ReservationHandlerDeps = {
  authenticate: (apiKey) => authenticateApiKey(db, apiKey),
  recordAuthFailure: (clientIp) =>
    hitRateLimit(
      db,
      RATE_LIMITS.apiKeyIp,
      rateLimitKey(RATE_LIMITS.apiKeyIp, clientIp),
    ),
  reserve: (projectId, request, now) =>
    reserveBudget(db, projectId, request, now),
  release: (projectId, reservationId, now) =>
    endReservation(db, { projectId, reservationId, status: "released", now }),
};
