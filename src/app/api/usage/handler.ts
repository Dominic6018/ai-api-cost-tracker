import type { RecordUsageResult } from "@/db/usage";
import { parseUsagePayload, type UsageInput } from "@/lib/usage";
import { authorizeApiKey, errorResponse, type ApiKeyDeps } from "../authorize";

/** Largest accepted request body. */
export const MAX_BODY_BYTES = 64 * 1024;

export interface UsageHandlerDeps extends ApiKeyDeps {
  recordUsage: (usage: UsageInput) => Promise<RecordUsageResult>;
}

type RecordUsageError = Extract<RecordUsageResult, { ok: false }>["error"];

const RECORD_ERRORS: Record<
  RecordUsageError,
  { status: number; message: string }
> = {
  no_pricing: {
    status: 422,
    message: "No price is configured for this model at occurredAt",
  },
  no_tier_pricing: {
    status: 422,
    message:
      "No price for this model's serviceTier at occurredAt; flex and fast usage needs that tier's own price (add one at /prices/new)",
  },
  no_batch_pricing: {
    status: 422,
    message:
      "No batch price is configured for this model at occurredAt; add one at /prices/new or send serviceTier standard",
  },
  project_not_found: { status: 404, message: "Project not found" },
  request_id_conflict: {
    status: 409,
    message:
      "This provider and requestId were already used for different usage",
  },
};

/** Builds the `POST /api/usage` handler; dependencies are injected for tests. */
export function createUsageHandler(deps: UsageHandlerDeps) {
  const now = () => deps.now?.() ?? new Date();
  return async function handleUsage(request: Request): Promise<Response> {
    const auth = await authorizeApiKey(request, deps);
    if (!auth.ok) return auth.response;

    const declaredLength = Number(request.headers.get("content-length"));
    if (declaredLength > MAX_BODY_BYTES) {
      return errorResponse(413, "payload_too_large", "Request body too large");
    }
    const text = await request.text();
    if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
      return errorResponse(413, "payload_too_large", "Request body too large");
    }

    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return errorResponse(400, "invalid_json", "Request body must be JSON");
    }

    const parsed = parseUsagePayload(body, now());
    if (!parsed.ok) {
      return errorResponse(400, "invalid_payload", "Invalid usage payload", {
        fieldErrors: parsed.fieldErrors,
        formErrors: parsed.formErrors,
      });
    }

    const result = await deps.recordUsage({
      ...parsed.usage,
      projectId: auth.projectId,
    });
    if (!result.ok) {
      const { status, message } = RECORD_ERRORS[result.error];
      return errorResponse(status, result.error, message);
    }

    const { event, replayed } = result;
    // 201 for a new event; 200 when a retry returns the stored one.
    return Response.json(
      {
        event: {
          id: event.id,
          projectId: event.projectId,
          provider: event.provider,
          model: event.model,
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          cachedInputTokens: event.cachedInputTokens,
          cacheWriteInputTokens: event.cacheWriteInputTokens,
          cacheWrite1hInputTokens: event.cacheWrite1hInputTokens,
          serviceTier: event.serviceTier,
          costUsd: event.costUsd,
          requestId: event.requestId,
          customerId: event.customerId,
          userId: event.userId,
          feature: event.feature,
          runId: event.runId,
          tags: event.tags,
          occurredAt: event.occurredAt.toISOString(),
        },
        replayed,
      },
      { status: replayed ? 200 : 201 },
    );
  };
}
