import { gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import type { AuthenticateResult } from "@/db/api-keys";
import type { RecordUsageResult } from "@/db/usage";
import type { UsageEvent } from "@/db/schema";
import { createOtlpTracesHandler, MAX_OTLP_BYTES } from "./handler";

const now = new Date("2026-11-02T12:00:00Z");
const projectId = "4f0c6c5e-2f7a-4b8e-9d1a-3c5e7f9a1b2c";
const apiKey = "act_" + "a".repeat(43);
// 2026-11-02T10:00:01Z in nanoseconds
const END = "1793613601000000000";

const intAttr = (key: string, value: number) => ({
  key,
  value: { intValue: String(value) },
});
const strAttr = (key: string, value: string) => ({
  key,
  value: { stringValue: value },
});

const genAiSpan = (spanId: string, model = "gpt-4.1") => ({
  traceId: "trace-1",
  spanId,
  endTimeUnixNano: END,
  attributes: [
    strAttr("gen_ai.operation.name", "chat"),
    strAttr("gen_ai.provider.name", "openai"),
    strAttr("gen_ai.request.model", model),
    intAttr("gen_ai.usage.input_tokens", 1000),
    intAttr("gen_ai.usage.output_tokens", 500),
  ],
});
const httpSpan = {
  traceId: "trace-1",
  spanId: "http-1",
  attributes: [strAttr("http.request.method", "POST")],
};
const exportOf = (...spans: unknown[]) => ({
  resourceSpans: [{ scopeSpans: [{ spans }] }],
});

const stored = { ok: true, event: {} as UsageEvent, replayed: false } as const;

function setup({
  auth = {
    ok: true,
    projectId,
    apiKeyId: "key-1",
    scope: "ingest",
  } as AuthenticateResult,
  results = [] as RecordUsageResult[],
} = {}) {
  const authenticate = vi.fn().mockResolvedValue(auth);
  const recordAuthFailure = vi.fn().mockResolvedValue({
    limited: false,
    resetAt: new Date(now.getTime() + 60_000),
  });
  const recordUsage = vi.fn(
    async () => results.shift() ?? (stored as RecordUsageResult),
  );
  const handler = createOtlpTracesHandler({
    authenticate,
    recordAuthFailure,
    recordUsage,
    now: () => now,
  });
  return { handler, recordUsage, recordAuthFailure };
}

function post(
  body: unknown,
  { contentType = "application/json", key = apiKey as string | null } = {},
) {
  const headers: Record<string, string> = { "content-type": contentType };
  if (key) headers.authorization = `Bearer ${key}`;
  return new Request("http://localhost/api/otel/v1/traces", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /api/otel/v1/traces", () => {
  it("records each GenAI span for the key's project and ignores the rest", async () => {
    const { handler, recordUsage } = setup();
    const response = await handler(
      post(exportOf(genAiSpan("s1"), httpSpan, genAiSpan("s2"))),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({});
    expect(recordUsage).toHaveBeenCalledTimes(2);
    expect(recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId,
        provider: "openai",
        model: "gpt-4.1",
        inputTokens: 1000,
        outputTokens: 500,
        requestId: "otel:trace-1:s1",
        occurredAt: new Date("2026-11-02T10:00:01Z"),
      }),
    );
  });

  it("reports spans it couldn't store as a partial success", async () => {
    const { handler } = setup({
      results: [
        stored,
        { ok: false, error: "request_id_conflict" },
        { ok: false, error: "request_id_conflict" },
      ],
    });
    const response = await handler(
      post(
        exportOf(
          genAiSpan("s1"),
          genAiSpan("s2", "unpriced-model"),
          genAiSpan("s3", "unpriced-model"),
        ),
      ),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      partialSuccess: {
        rejectedSpans: 2,
        errorMessage: "2 span(s): request_id_conflict",
      },
    });
  });

  it("rejects spans that fail usage validation without recording them", async () => {
    const { handler, recordUsage } = setup();
    const noModel = {
      ...genAiSpan("s1"),
      attributes: [intAttr("gen_ai.usage.input_tokens", 10)],
    };
    const response = await handler(post(exportOf(noModel)));
    expect(await response.json()).toEqual({
      partialSuccess: {
        rejectedSpans: 1,
        errorMessage: "1 span(s): invalid model",
      },
    });
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it("requires an API key, and counts rejected ones", async () => {
    const missing = setup();
    const noKey = await missing.handler(post(exportOf(), { key: null }));
    expect(noKey.status).toBe(401);
    expect(missing.recordAuthFailure).not.toHaveBeenCalled();

    const bad = setup({ auth: { ok: false } });
    const rejected = await bad.handler(post(exportOf(genAiSpan("s1"))));
    expect(rejected.status).toBe(401);
    expect(bad.recordAuthFailure).toHaveBeenCalled();
    expect(bad.recordUsage).not.toHaveBeenCalled();
  });

  it("explains that only JSON is supported", async () => {
    const { handler, recordUsage } = setup();
    const response = await handler(
      post("binary", { contentType: "application/x-protobuf" }),
    );
    expect(response.status).toBe(415);
    expect((await response.json()).error.message).toMatch(/encoding: json/);
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it("accepts a JSON content type with parameters", async () => {
    const { handler } = setup();
    const response = await handler(
      post(exportOf(), { contentType: "application/json; charset=utf-8" }),
    );
    expect(response.status).toBe(200);
  });

  it.each([
    ["malformed JSON", "{not json", "invalid_json"],
    ["a body that isn't an OTLP export", { spans: [] }, "invalid_payload"],
  ])("returns 400 for %s", async (_, body, code) => {
    const { handler } = setup();
    const response = await handler(post(body));
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe(code);
  });

  it("accepts gzip, which the Collector's otlphttp exporter sends by default", async () => {
    const { handler, recordUsage } = setup();
    const response = await handler(
      new Request("http://localhost/api/otel/v1/traces", {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          "content-encoding": "gzip",
        },
        body: gzipSync(JSON.stringify(exportOf(genAiSpan("s1")))),
      }),
    );
    expect(response.status).toBe(200);
    expect(recordUsage).toHaveBeenCalledTimes(1);
  });

  it("limits the size after decompression, and rejects broken gzip", async () => {
    const { handler } = setup();
    const gzipped = (body: BodyInit) =>
      new Request("http://localhost/api/otel/v1/traces", {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          "content-encoding": "gzip",
        },
        body,
      });
    // About 4 KB compressed, over 4 MB once expanded.
    const bomb = new Uint8Array(gzipSync(" ".repeat(MAX_OTLP_BYTES + 1)));
    expect(bomb.byteLength).toBeLessThan(64 * 1024);
    expect((await handler(gzipped(bomb))).status).toBe(413);
    expect((await handler(gzipped("not gzip"))).status).toBe(400);
  });

  it("returns 413 for an oversized export", async () => {
    const { handler } = setup();
    const response = await handler(post("x".repeat(MAX_OTLP_BYTES + 1)));
    expect(response.status).toBe(413);
  });
});
