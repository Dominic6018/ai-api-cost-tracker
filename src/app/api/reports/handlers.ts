import type { SpendReport } from "@/db/reports";
import type { UsageEventsPage } from "@/db/usage-events";
import {
  parseReportLimit,
  parseSpendQuery,
  type SpendQuery,
} from "@/lib/reports";
import {
  decodeCursor,
  encodeCursor,
  parseUsageFilters,
  type UsageFilters,
} from "@/lib/usage-filters";
import { authorizeApiKey, errorResponse, type ApiKeyDeps } from "../authorize";

export interface ReportHandlerDeps extends ApiKeyDeps {
  getSpendReport: (
    query: SpendQuery & { projectId: string },
  ) => Promise<SpendReport>;
  listUsageEvents: (
    filters: UsageFilters,
    pageSize: number,
  ) => Promise<UsageEventsPage>;
}

const json = (body: unknown) =>
  Response.json(body, { headers: { "cache-control": "no-store" } });

/** `GET /api/reports/spend`: one project's spend, grouped, for a read key. */
export function createSpendReportHandler(deps: ReportHandlerDeps) {
  return async function handleSpendReport(request: Request) {
    const auth = await authorizeApiKey(request, deps, "read");
    if (!auth.ok) return auth.response;

    const parsed = parseSpendQuery(
      new URL(request.url).searchParams,
      deps.now?.() ?? new Date(),
    );
    if (!parsed.ok) {
      return errorResponse(400, "invalid_query", "Invalid report query", {
        fieldErrors: parsed.fieldErrors,
      });
    }
    const { from, to, groupBy } = parsed.query;
    const report = await deps.getSpendReport({
      ...parsed.query,
      projectId: auth.projectId,
    });
    return json({
      projectId: auth.projectId,
      from,
      to,
      groupBy,
      currency: "USD",
      ...report,
    });
  };
}

/** `GET /api/reports/usage`: one project's usage events, paginated, for a read key. */
export function createUsageReportHandler(deps: ReportHandlerDeps) {
  return async function handleUsageReport(request: Request) {
    const auth = await authorizeApiKey(request, deps, "read");
    if (!auth.ok) return auth.response;

    const params = new URL(request.url).searchParams;
    const limit = parseReportLimit(params.get("limit"));
    if (!limit.ok) {
      return errorResponse(400, "invalid_query", limit.error);
    }
    // A cursor this API didn't issue would silently restart the listing,
    // which can loop a client forever, so it's an error instead.
    const cursorParam = params.get("cursor");
    if (cursorParam !== null && !decodeCursor(cursorParam)) {
      return errorResponse(400, "invalid_query", "Unknown cursor");
    }
    // The key decides the project; a project parameter is ignored.
    const { projectId, ...filters } = parseUsageFilters(
      Object.fromEntries(params),
    );
    void projectId;
    const page = await deps.listUsageEvents(
      { ...filters, projectId: auth.projectId },
      limit.limit,
    );
    return json({
      projectId: auth.projectId,
      events: page.rows.map((row) => ({
        id: row.id,
        occurredAt: row.occurredAt.toISOString(),
        provider: row.provider,
        model: row.model,
        inputTokens: row.inputTokens,
        cachedInputTokens: row.cachedInputTokens,
        cacheWriteInputTokens: row.cacheWriteInputTokens,
        outputTokens: row.outputTokens,
        costUsd: row.costUsd,
        requestId: row.requestId,
        customerId: row.customerId,
        userId: row.userId,
        feature: row.feature,
        runId: row.runId,
        tags: row.tags,
      })),
      nextCursor: page.next ? encodeCursor(page.next) : null,
    });
  };
}
