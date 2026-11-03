import { db } from "@/db";
import { authenticateApiKey } from "@/db/api-keys";
import { recordOutcome } from "@/db/outcomes";
import { hitRateLimit } from "@/db/rate-limits";
import { RATE_LIMITS, rateLimitKey } from "@/lib/rate-limit";
import { createOutcomesHandler } from "./handler";

export const POST = createOutcomesHandler({
  authenticate: (apiKey) => authenticateApiKey(db, apiKey),
  recordAuthFailure: (clientIp) =>
    hitRateLimit(
      db,
      RATE_LIMITS.apiKeyIp,
      rateLimitKey(RATE_LIMITS.apiKeyIp, clientIp),
    ),
  recordOutcome: (outcome) => recordOutcome(db, outcome),
});
