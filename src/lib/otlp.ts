/**
 * Reads GenAI token usage from OTLP/HTTP JSON trace exports, following the
 * OpenTelemetry GenAI semantic conventions (`gen_ai.*` span attributes).
 */

import type { Provider } from "@/db/schema";
import {
  MAX_ATTRIBUTION_LENGTH,
  type Attribution,
  type AttributionKey,
} from "./attribution";

/** A GenAI span's usage, shaped as a `POST /api/usage` body. */
export interface OtlpSpanUsage {
  spanId: string;
  payload: Record<string, unknown>;
}

export type OtlpParseResult =
  | {
      ok: true;
      spans: OtlpSpanUsage[];
      /** Spans without GenAI usage, or that only aggregate other spans. */
      skipped: number;
    }
  | { ok: false; error: string };

/**
 * Operations whose usage is aggregated from model calls they contain, so
 * counting them as well would count the same tokens twice.
 */
const AGGREGATE_OPERATIONS = new Set([
  "invoke_agent",
  "create_agent",
  "invoke_workflow",
  "execute_tool",
  "retrieval",
]);

/**
 * `gen_ai.provider.name` values, plus the older `gen_ai.system` values some
 * instrumentations still send. Anything else is recorded as "other".
 */
const PROVIDERS: Record<string, Provider> = {
  openai: "openai",
  "azure.ai.openai": "openai",
  "az.ai.openai": "openai",
  anthropic: "anthropic",
  "gcp.gemini": "google",
  "gcp.vertex_ai": "google",
  "gcp.gen_ai": "google",
  gemini: "google",
  vertex_ai: "google",
  mistral_ai: "mistral",
};

/**
 * Span (or resource) attributes read as attribution, first match wins.
 * Only the user has a standard attribute; the others use this app's own
 * namespaced names, documented in docs/OPENTELEMETRY.md.
 */
const ATTRIBUTION_ATTRIBUTES: Record<AttributionKey, string[]> = {
  customerId: ["cost_tracker.customer_id"],
  userId: ["cost_tracker.user_id", "user.id", "enduser.id"],
  feature: ["cost_tracker.feature"],
  runId: ["cost_tracker.run_id"],
};

type AttributeValue = string | number | boolean | undefined;

interface OtlpKeyValue {
  key?: unknown;
  value?: {
    stringValue?: unknown;
    intValue?: unknown;
    doubleValue?: unknown;
    boolValue?: unknown;
  };
}

/** OTLP attribute lists as a map. int64 values arrive as JSON strings. */
function attributes(list: unknown): Map<string, AttributeValue> {
  const map = new Map<string, AttributeValue>();
  if (!Array.isArray(list)) return map;
  for (const item of list as OtlpKeyValue[]) {
    if (typeof item?.key !== "string" || !item.value) continue;
    const { stringValue, intValue, doubleValue, boolValue } = item.value;
    let value: AttributeValue;
    if (typeof stringValue === "string") value = stringValue;
    else if (typeof intValue === "string" && /^-?\d+$/.test(intValue))
      value = Number(intValue);
    else if (typeof intValue === "number") value = intValue;
    else if (typeof doubleValue === "number") value = doubleValue;
    else if (typeof boolValue === "boolean") value = boolValue;
    map.set(item.key, value);
  }
  return map;
}

function tokens(
  attrs: Map<string, AttributeValue>,
  ...names: string[]
): number | undefined {
  for (const name of names) {
    const value = attrs.get(name);
    if (typeof value === "number") return value;
  }
  return undefined;
}

function text(attrs: Map<string, AttributeValue>, ...names: string[]) {
  for (const name of names) {
    const value = attrs.get(name);
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

/**
 * Attribution from span attributes, falling back to resource attributes,
 * so a service can set its feature once on the resource. Values that the
 * usage API would reject are dropped instead, so the span's usage counts.
 */
function attribution(
  span: Map<string, AttributeValue>,
  resource: Map<string, AttributeValue>,
): Attribution {
  const result: Attribution = {};
  for (const [key, names] of Object.entries(ATTRIBUTION_ATTRIBUTES) as [
    AttributionKey,
    string[],
  ][]) {
    const value = text(span, ...names) ?? text(resource, ...names);
    if (value && value.length <= MAX_ATTRIBUTION_LENGTH) result[key] = value;
  }
  return result;
}

/** Nanoseconds since the epoch (a decimal string or number) as ISO 8601. */
function isoFromNanos(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  if (!/^\d+$/.test(String(value))) return undefined;
  const millis = Number(BigInt(String(value)) / BigInt(1_000_000));
  return millis > 0 ? new Date(millis).toISOString() : undefined;
}

const asArray = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];

/** Extracts the usage of every GenAI model call in an OTLP trace export. */
export function genAiUsageFromOtlp(body: unknown): OtlpParseResult {
  if (
    !body ||
    typeof body !== "object" ||
    !Array.isArray((body as { resourceSpans?: unknown }).resourceSpans)
  ) {
    return { ok: false, error: "Expected an OTLP trace export: resourceSpans" };
  }

  const spans: OtlpSpanUsage[] = [];
  let skipped = 0;
  for (const resourceSpans of (body as { resourceSpans: unknown[] })
    .resourceSpans) {
    const resource = attributes(
      (resourceSpans as { resource?: { attributes?: unknown } })?.resource
        ?.attributes,
    );
    const service = text(resource, "service.name");
    for (const scopeSpans of asArray(
      (resourceSpans as { scopeSpans?: unknown })?.scopeSpans,
    )) {
      for (const span of asArray(
        (scopeSpans as { spans?: unknown })?.spans,
      ) as Array<Record<string, unknown>>) {
        const attrs = attributes(span?.attributes);
        const operation = text(attrs, "gen_ai.operation.name");
        const input = tokens(
          attrs,
          "gen_ai.usage.input_tokens",
          "gen_ai.usage.prompt_tokens",
        );
        const output = tokens(
          attrs,
          "gen_ai.usage.output_tokens",
          "gen_ai.usage.completion_tokens",
        );
        const spanId = typeof span?.spanId === "string" ? span.spanId : "";
        if (
          (input === undefined && output === undefined) ||
          (operation && AGGREGATE_OPERATIONS.has(operation)) ||
          !spanId
        ) {
          skipped++;
          continue;
        }

        const cacheRead =
          tokens(attrs, "gen_ai.usage.cache_read.input_tokens") ?? 0;
        const cacheWrite =
          tokens(attrs, "gen_ai.usage.cache_creation.input_tokens") ?? 0;
        // The conventions include cache reads and writes in input_tokens.
        // Instrumentations that copy Anthropic's fields report them
        // separately; when they can't fit inside input, add them back.
        let inputTokens = input ?? 0;
        if (cacheRead + cacheWrite > inputTokens) {
          inputTokens += cacheRead + cacheWrite;
        }

        const providerName = text(
          attrs,
          "gen_ai.provider.name",
          "gen_ai.system",
        );
        const traceId = typeof span.traceId === "string" ? span.traceId : "";
        spans.push({
          spanId,
          payload: {
            provider: PROVIDERS[providerName ?? ""] ?? "other",
            // The requested model is usually the alias that has a price;
            // the response may name a dated snapshot.
            model: text(attrs, "gen_ai.request.model", "gen_ai.response.model"),
            inputTokens,
            outputTokens: output ?? 0,
            cachedInputTokens: cacheRead,
            cacheWriteInputTokens: cacheWrite,
            // Collectors retry exports, so the span identifies the record.
            requestId: `otel:${traceId}:${spanId}`,
            ...attribution(attrs, resource),
            occurredAt:
              isoFromNanos(span.endTimeUnixNano) ??
              isoFromNanos(span.startTimeUnixNano),
            metadata: {
              source: "otel",
              ...(service && { service }),
              ...(operation && { operation }),
              ...(providerName && { providerName }),
              traceId,
              spanId,
            },
          },
        });
      }
    }
  }
  return { ok: true, spans, skipped };
}
