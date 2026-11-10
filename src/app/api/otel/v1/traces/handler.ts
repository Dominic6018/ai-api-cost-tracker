import type { RecordUsageResult } from "@/db/usage";
import { genAiUsageFromOtlp } from "@/lib/otlp";
import { parseUsagePayload, type UsageInput } from "@/lib/usage";
import {
  authorizeApiKey,
  errorResponse,
  type ApiKeyDeps,
} from "../../../authorize";

/** Largest accepted export; collectors batch many spans per request. */
export const MAX_OTLP_BYTES = 4 * 1024 * 1024;

export interface OtlpTracesHandlerDeps extends ApiKeyDeps {
  recordUsage: (usage: UsageInput) => Promise<RecordUsageResult>;
  /** Counts spans that failed validation, for ingestion health. */
  countInvalid?: (projectId: string, n: number) => Promise<void>;
}

/**
 * Reads the body as text, gunzipping it when the exporter compressed it
 * (the Collector's otlphttp exporter does by default). The limit applies
 * after decompression, so a small upload can't expand without bound.
 * Returns null when it's too large and undefined when it isn't valid gzip.
 */
async function readBody(
  request: Request,
  gzip: boolean,
): Promise<string | null | undefined> {
  if (!request.body) return "";
  const stream = gzip
    ? request.body.pipeThrough(new DecompressionStream("gzip"))
    : request.body;
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_OTLP_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return undefined;
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/**
 * Builds the OTLP/HTTP JSON traces endpoint. GenAI model-call spans become
 * usage events, priced and de-duplicated like `POST /api/usage`; other
 * spans are ignored. Per OTLP, spans that can't be stored are reported in
 * `partialSuccess` rather than failing the whole export.
 */
export function createOtlpTracesHandler(deps: OtlpTracesHandlerDeps) {
  const now = () => deps.now?.() ?? new Date();
  return async function handleTraces(request: Request): Promise<Response> {
    const auth = await authorizeApiKey(request, deps);
    if (!auth.ok) return auth.response;

    const type = (request.headers.get("content-type") ?? "")
      .split(";")[0]
      .trim()
      .toLowerCase();
    if (type !== "application/json") {
      return errorResponse(
        415,
        "unsupported_media_type",
        "Send OTLP/HTTP JSON (Content-Type: application/json). In the OpenTelemetry Collector, set `encoding: json` on the otlphttp exporter.",
      );
    }
    const encoding = (request.headers.get("content-encoding") ?? "identity")
      .trim()
      .toLowerCase();
    if (encoding !== "identity" && encoding !== "gzip") {
      return errorResponse(
        415,
        "unsupported_media_type",
        "Content-Encoding must be gzip or none",
      );
    }
    if (Number(request.headers.get("content-length")) > MAX_OTLP_BYTES) {
      return errorResponse(413, "payload_too_large", "Export too large");
    }
    const text = await readBody(request, encoding === "gzip");
    if (text === null) {
      return errorResponse(413, "payload_too_large", "Export too large");
    }
    if (text === undefined) {
      return errorResponse(400, "invalid_body", "Body isn't valid gzip");
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return errorResponse(400, "invalid_json", "Request body must be JSON");
    }

    const parsed = genAiUsageFromOtlp(body);
    if (!parsed.ok) {
      return errorResponse(400, "invalid_payload", parsed.error);
    }

    // Counted per reason, so the message stays short for large exports.
    const reasons = new Map<string, number>();
    const reject = (reason: string) =>
      reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    for (const span of parsed.spans) {
      const usage = parseUsagePayload(span.payload, now());
      if (!usage.ok) {
        const fields = Object.keys(usage.fieldErrors);
        reject(`invalid ${fields.length > 0 ? fields.join(", ") : "usage"}`);
        continue;
      }
      const result = await deps.recordUsage({
        ...usage.usage,
        projectId: auth.projectId,
      });
      if (!result.ok) {
        // Usage without a price is stored as unpriced, not rejected.
        reject(result.error);
      }
    }

    const invalidSpans = [...reasons]
      .filter(([reason]) => reason.startsWith("invalid"))
      .reduce((sum, [, n]) => sum + n, 0);
    await deps.countInvalid?.(auth.projectId, invalidSpans);
    const rejectedSpans = [...reasons.values()].reduce((a, b) => a + b, 0);
    if (rejectedSpans === 0) return Response.json({});
    return Response.json({
      partialSuccess: {
        rejectedSpans,
        errorMessage: [...reasons]
          .map(([reason, count]) => `${count} span(s): ${reason}`)
          .join("; "),
      },
    });
  };
}
