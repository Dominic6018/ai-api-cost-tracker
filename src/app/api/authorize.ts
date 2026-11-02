import type { AuthenticateResult } from "@/db/api-keys";
import type { RateLimitResult } from "@/db/rate-limits";
import { parseBearerToken } from "@/lib/api-keys";
import { clientIp, retryAfterSeconds } from "@/lib/rate-limit";

export interface ApiKeyDeps {
  authenticate: (apiKey: string) => Promise<AuthenticateResult>;
  /** Counts a rejected key from this client IP against its rate limit. */
  recordAuthFailure: (clientIp: string) => Promise<RateLimitResult>;
  now?: () => Date;
}

export type AuthorizeResult =
  { ok: true; projectId: string } | { ok: false; response: Response };

export function errorResponse(
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): Response {
  return Response.json({ error: { code, message, ...extra } }, { status });
}

/**
 * Checks the request's `Authorization: Bearer <key>`. On failure, returns
 * the 401, or the 429 once this client IP has sent too many invalid keys.
 */
export async function authorizeApiKey(
  request: Request,
  deps: ApiKeyDeps,
): Promise<AuthorizeResult> {
  const apiKey = parseBearerToken(request.headers.get("authorization"));
  const auth = apiKey
    ? await deps.authenticate(apiKey)
    : ({ ok: false } as const);
  if (auth.ok) return { ok: true, projectId: auth.projectId };

  // Only rejected keys are counted, so valid requests cost no extra query.
  // Requests without a key aren't guessing one, and never reach the database.
  if (apiKey) {
    const limit = await deps.recordAuthFailure(clientIp(request.headers));
    if (limit.limited) {
      const retryAfter = retryAfterSeconds(
        limit.resetAt,
        deps.now?.() ?? new Date(),
      );
      const response = errorResponse(
        429,
        "rate_limited",
        `Too many invalid API keys from this address. Retry in ${retryAfter} seconds.`,
      );
      response.headers.set("Retry-After", String(retryAfter));
      return { ok: false, response };
    }
  }
  const response = errorResponse(
    401,
    "unauthorized",
    "A valid API key is required: Authorization: Bearer <key>",
  );
  response.headers.set("WWW-Authenticate", 'Bearer realm="api"');
  return { ok: false, response };
}
