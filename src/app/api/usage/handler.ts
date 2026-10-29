import type { AuthenticateResult } from "@/db/api-keys";
import type { RecordUsageResult } from "@/db/usage";
import { parseBearerToken } from "@/lib/api-keys";
import { parseUsagePayload, type UsageInput } from "@/lib/usage";

/** Largest accepted request body. */
export const MAX_BODY_BYTES = 64 * 1024;

export interface UsageHandlerDeps {
  authenticate: (apiKey: string) => Promise<AuthenticateResult>;
  recordUsage: (usage: UsageInput) => Promise<RecordUsageResult>;
  now?: () => Date;
}

type ErrorCode =
  | "unauthorized"
  | "payload_too_large"
  | "invalid_json"
  | "invalid_payload"
  | RecordUsageError;

type RecordUsageError = Extract<RecordUsageResult, { ok: false }>["error"];

function errorResponse(
  status: number,
  code: ErrorCode,
  message: string,
  extra: Record<string, unknown> = {},
): Response {
  return Response.json({ error: { code, message, ...extra } }, { status });
}

const RECORD_ERRORS: Record<
  RecordUsageError,
  { status: number; message: string }
> = {
  no_pricing: {
    status: 422,
    message: "No price is configured for this model at occurredAt",
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
  return async function handleUsage(request: Request): Promise<Response> {
    const apiKey = parseBearerToken(request.headers.get("authorization"));
    const auth = apiKey
      ? await deps.authenticate(apiKey)
      : ({ ok: false } as const);
    if (!auth.ok) {
      const response = errorResponse(
        401,
        "unauthorized",
        "A valid API key is required: Authorization: Bearer <key>",
      );
      response.headers.set("WWW-Authenticate", 'Bearer realm="api"');
      return response;
    }

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

    const parsed = parseUsagePayload(body, deps.now?.() ?? new Date());
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
          costUsd: event.costUsd,
          requestId: event.requestId,
          occurredAt: event.occurredAt.toISOString(),
        },
        replayed,
      },
      { status: replayed ? 200 : 201 },
    );
  };
}
