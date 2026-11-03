import type { RecordOutcomeResult } from "@/db/outcomes";
import { parseOutcomePayload, type OutcomeInput } from "@/lib/outcomes";
import { authorizeApiKey, errorResponse, type ApiKeyDeps } from "../authorize";

/** Largest accepted request body. */
export const MAX_BODY_BYTES = 16 * 1024;

export interface OutcomesHandlerDeps extends ApiKeyDeps {
  recordOutcome: (outcome: OutcomeInput) => Promise<RecordOutcomeResult>;
}

/** Builds the `POST /api/outcomes` handler; dependencies are injected for tests. */
export function createOutcomesHandler(deps: OutcomesHandlerDeps) {
  const now = () => deps.now?.() ?? new Date();
  return async function handleOutcome(request: Request): Promise<Response> {
    const auth = await authorizeApiKey(request, deps);
    if (!auth.ok) return auth.response;

    if (Number(request.headers.get("content-length")) > MAX_BODY_BYTES) {
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

    const parsed = parseOutcomePayload(body, now());
    if (!parsed.ok) {
      return errorResponse(400, "invalid_payload", "Invalid outcome", {
        fieldErrors: parsed.fieldErrors,
        formErrors: parsed.formErrors,
      });
    }

    const result = await deps.recordOutcome({
      ...parsed.outcome,
      projectId: auth.projectId,
    });
    if (!result.ok) {
      return result.error === "project_not_found"
        ? errorResponse(404, "project_not_found", "Project not found")
        : errorResponse(
            409,
            "outcome_id_conflict",
            "This outcomeId was already used for a different outcome",
          );
    }

    const { outcome, replayed } = result;
    // 201 for a new outcome; 200 when a retry returns the stored one.
    return Response.json(
      {
        outcome: {
          id: outcome.id,
          projectId: outcome.projectId,
          name: outcome.name,
          count: outcome.count,
          outcomeId: outcome.outcomeId,
          customerId: outcome.customerId,
          userId: outcome.userId,
          feature: outcome.feature,
          runId: outcome.runId,
          occurredAt: outcome.occurredAt.toISOString(),
        },
        replayed,
      },
      { status: replayed ? 200 : 201 },
    );
  };
}
