import { db } from "@/db";
import { authenticateApiKey } from "@/db/api-keys";
import { hitRateLimit } from "@/db/rate-limits";
import { recordUsage } from "@/db/usage";
import { RATE_LIMITS, rateLimitKey } from "@/lib/rate-limit";
import { createOtlpTracesHandler } from "./handler";

export const POST = createOtlpTracesHandler({
  authenticate: (apiKey) => authenticateApiKey(db, apiKey),
  recordAuthFailure: (clientIp) =>
    hitRateLimit(
      db,
      RATE_LIMITS.apiKeyIp,
      rateLimitKey(RATE_LIMITS.apiKeyIp, clientIp),
    ),
  recordUsage: (usage) => recordUsage(db, usage),
});
