import {
  decideBudgetCheck,
  parseBudgetCheckPayload,
  type BudgetCheckInputs,
} from "@/lib/budget-check";
import {
  authorizeApiKey,
  errorResponse,
  type ApiKeyDeps,
} from "../../authorize";

/** Largest accepted request body. */
export const MAX_BODY_BYTES = 4 * 1024;

export interface BudgetCheckHandlerDeps extends ApiKeyDeps {
  getInputs: (
    projectId: string,
    runId: string | undefined,
    now: Date,
  ) => Promise<BudgetCheckInputs | undefined>;
}

/**
 * Builds the `POST /api/budget/check` handler; dependencies are injected
 * for tests. It takes the ingest key the app already uses to send usage.
 */
export function createBudgetCheckHandler(deps: BudgetCheckHandlerDeps) {
  const now = () => deps.now?.() ?? new Date();
  return async function handleBudgetCheck(request: Request): Promise<Response> {
    const auth = await authorizeApiKey(request, deps);
    if (!auth.ok) return auth.response;

    if (Number(request.headers.get("content-length")) > MAX_BODY_BYTES) {
      return errorResponse(413, "payload_too_large", "Request body too large");
    }
    const text = await request.text();
    if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
      return errorResponse(413, "payload_too_large", "Request body too large");
    }
    // An empty body asks about the month alone, with no estimate.
    let body: unknown = {};
    if (text.trim()) {
      try {
        body = JSON.parse(text);
      } catch {
        return errorResponse(400, "invalid_json", "Request body must be JSON");
      }
    }

    const parsed = parseBudgetCheckPayload(body);
    if (!parsed.ok) {
      return errorResponse(400, "invalid_payload", "Invalid budget check", {
        fieldErrors: parsed.fieldErrors,
        formErrors: parsed.formErrors,
      });
    }

    const at = now();
    const inputs = await deps.getInputs(
      auth.projectId,
      parsed.request.runId,
      at,
    );
    if (!inputs) {
      return errorResponse(404, "project_not_found", "Project not found");
    }
    // A denial is an answer, not an error: always 200, never cached.
    return Response.json(decideBudgetCheck(parsed.request, inputs, at), {
      headers: { "cache-control": "no-store" },
    });
  };
}
