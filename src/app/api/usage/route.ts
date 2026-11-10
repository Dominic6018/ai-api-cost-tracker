import { db } from "@/db";
import { authenticateApiKey } from "@/db/api-keys";
import { hitRateLimit } from "@/db/rate-limits";
import { countIngestion, recordAndCount } from "@/db/ingestion-health";
import { RATE_LIMITS, rateLimitKey } from "@/lib/rate-limit";
import { createUsageHandler } from "./handler";

export const POST = createUsageHandler({
  authenticate: (apiKey) => authenticateApiKey(db, apiKey),
  recordAuthFailure: (clientIp) =>
    hitRateLimit(
      db,
      RATE_LIMITS.apiKeyIp,
      rateLimitKey(RATE_LIMITS.apiKeyIp, clientIp),
    ),
  recordUsage: (usage) => recordAndCount(db, usage),
  countInvalid: (projectId, n) => countIngestion(db, projectId, "invalid", n),
});
