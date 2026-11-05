import { db } from "@/db";
import { authenticateApiKey } from "@/db/api-keys";
import { getBudgetCheckInputs } from "@/db/budget-check";
import { hitRateLimit } from "@/db/rate-limits";
import { RATE_LIMITS, rateLimitKey } from "@/lib/rate-limit";
import { createBudgetCheckHandler } from "./handler";

export const POST = createBudgetCheckHandler({
  authenticate: (apiKey) => authenticateApiKey(db, apiKey),
  recordAuthFailure: (clientIp) =>
    hitRateLimit(
      db,
      RATE_LIMITS.apiKeyIp,
      rateLimitKey(RATE_LIMITS.apiKeyIp, clientIp),
    ),
  getInputs: (projectId, runId, now) =>
    getBudgetCheckInputs(db, projectId, runId, now),
});
