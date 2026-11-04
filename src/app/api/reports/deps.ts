import { db } from "@/db";
import { authenticateApiKey } from "@/db/api-keys";
import { hitRateLimit } from "@/db/rate-limits";
import { getSpendReport } from "@/db/reports";
import { listUsageEvents } from "@/db/usage-events";
import { RATE_LIMITS, rateLimitKey } from "@/lib/rate-limit";
import type { ReportHandlerDeps } from "./handlers";

export const reportDeps: ReportHandlerDeps = {
  authenticate: (apiKey) => authenticateApiKey(db, apiKey),
  recordAuthFailure: (clientIp) =>
    hitRateLimit(
      db,
      RATE_LIMITS.apiKeyIp,
      rateLimitKey(RATE_LIMITS.apiKeyIp, clientIp),
    ),
  getSpendReport: (query) => getSpendReport(db, query),
  listUsageEvents: (filters, pageSize) =>
    listUsageEvents(db, filters, pageSize),
};
