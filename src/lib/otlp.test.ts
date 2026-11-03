import { describe, expect, it } from "vitest";
import { genAiUsageFromOtlp } from "./otlp";
import { parseUsagePayload } from "./usage";

type Attr = [string, string | number | boolean];

/** An OTLP/HTTP JSON attribute list; ints are encoded as strings, like OTLP JSON. */
const attrs = (...pairs: Attr[]) =>
  pairs.map(([key, value]) => ({
    key,
    value:
      typeof value === "string"
        ? { stringValue: value }
        : typeof value === "boolean"
          ? { boolValue: value }
          : Number.isInteger(value)
            ? { intValue: String(value) }
            : { doubleValue: value },
  }));

// 2026-11-02T10:00:00.000Z and one second later, in nanoseconds.
const START = "1793613600000000000";
const END = "1793613601000000000";

const span = (spanId: string, ...pairs: Attr[]) => ({
  traceId: "5b8efff798038103d269b633813fc60c",
  spanId,
  name: "chat",
  startTimeUnixNano: START,
  endTimeUnixNano: END,
  attributes: attrs(...pairs),
});

const exportOf = (...spans: unknown[]) => ({
  resourceSpans: [
    {
      resource: { attributes: attrs(["service.name", "support-bot"]) },
      scopeSpans: [{ scope: { name: "test" }, spans }],
    },
  ],
});

const chat = span(
  "eee19b7ec3c1b174",
  ["gen_ai.operation.name", "chat"],
  ["gen_ai.provider.name", "openai"],
  ["gen_ai.request.model", "gpt-4.1"],
  ["gen_ai.response.model", "gpt-4.1-2025-04-14"],
  ["gen_ai.usage.input_tokens", 1200],
  ["gen_ai.usage.output_tokens", 300],
  ["gen_ai.usage.cache_read.input_tokens", 1024],
);

describe("genAiUsageFromOtlp", () => {
  it("turns a GenAI chat span into a usage payload", () => {
    const result = genAiUsageFromOtlp(exportOf(chat));
    expect(result).toEqual({
      ok: true,
      skipped: 0,
      spans: [
        {
          spanId: "eee19b7ec3c1b174",
          payload: {
            provider: "openai",
            // The requested alias, not the dated snapshot.
            model: "gpt-4.1",
            inputTokens: 1200,
            outputTokens: 300,
            cachedInputTokens: 1024,
            cacheWriteInputTokens: 0,
            requestId: "otel:5b8efff798038103d269b633813fc60c:eee19b7ec3c1b174",
            occurredAt: "2026-11-02T10:00:01.000Z",
            metadata: {
              source: "otel",
              service: "support-bot",
              operation: "chat",
              providerName: "openai",
              traceId: "5b8efff798038103d269b633813fc60c",
              spanId: "eee19b7ec3c1b174",
            },
          },
        },
      ],
    });
  });

  it("produces payloads the usage API accepts", () => {
    const result = genAiUsageFromOtlp(exportOf(chat));
    if (!result.ok) throw new Error("expected ok");
    const parsed = parseUsagePayload(
      result.spans[0].payload,
      new Date("2026-11-02T12:00:00Z"),
    );
    expect(parsed.ok).toBe(true);
  });

  it("skips agent, tool and workflow spans, whose usage would count twice", () => {
    const usage: Attr[] = [
      ["gen_ai.usage.input_tokens", 5000],
      ["gen_ai.usage.output_tokens", 900],
    ];
    const result = genAiUsageFromOtlp(
      exportOf(
        span("a1", ["gen_ai.operation.name", "invoke_agent"], ...usage),
        span("a2", ["gen_ai.operation.name", "execute_tool"], ...usage),
        span("a3", ["gen_ai.operation.name", "invoke_workflow"], ...usage),
        span("a4", ["gen_ai.operation.name", "embeddings"], ...usage),
      ),
    );
    expect(result.ok && result.spans.map((s) => s.spanId)).toEqual(["a4"]);
    expect(result.ok && result.skipped).toBe(3);
  });

  it("skips spans without GenAI usage, such as HTTP or database spans", () => {
    const result = genAiUsageFromOtlp(
      exportOf(
        span("b1", ["http.request.method", "POST"]),
        span("b2", ["gen_ai.operation.name", "chat"]),
      ),
    );
    expect(result).toEqual({ ok: true, spans: [], skipped: 2 });
  });

  it("maps provider names, including the deprecated gen_ai.system", () => {
    const providerOf = (...pairs: Attr[]) => {
      const result = genAiUsageFromOtlp(
        exportOf(span("c1", ["gen_ai.usage.input_tokens", 1], ...pairs)),
      );
      return result.ok ? result.spans[0].payload.provider : null;
    };
    expect(providerOf(["gen_ai.provider.name", "anthropic"])).toBe("anthropic");
    expect(providerOf(["gen_ai.provider.name", "gcp.gemini"])).toBe("google");
    expect(providerOf(["gen_ai.provider.name", "gcp.vertex_ai"])).toBe(
      "google",
    );
    expect(providerOf(["gen_ai.provider.name", "azure.ai.openai"])).toBe(
      "openai",
    );
    expect(providerOf(["gen_ai.provider.name", "mistral_ai"])).toBe("mistral");
    expect(providerOf(["gen_ai.system", "anthropic"])).toBe("anthropic");
    expect(providerOf(["gen_ai.provider.name", "groq"])).toBe("other");
    expect(providerOf()).toBe("other");
  });

  it("reads the deprecated prompt_tokens and completion_tokens", () => {
    const result = genAiUsageFromOtlp(
      exportOf(
        span(
          "d1",
          ["gen_ai.system", "openai"],
          ["gen_ai.request.model", "gpt-4.1"],
          ["gen_ai.usage.prompt_tokens", 100],
          ["gen_ai.usage.completion_tokens", 20],
        ),
      ),
    );
    expect(result.ok && result.spans[0].payload).toMatchObject({
      inputTokens: 100,
      outputTokens: 20,
    });
  });

  it("keeps cache traffic inside input_tokens, as the conventions specify", () => {
    const result = genAiUsageFromOtlp(
      exportOf(
        span(
          "e1",
          ["gen_ai.provider.name", "anthropic"],
          ["gen_ai.usage.input_tokens", 10_050],
          ["gen_ai.usage.output_tokens", 400],
          ["gen_ai.usage.cache_read.input_tokens", 8000],
          ["gen_ai.usage.cache_creation.input_tokens", 2000],
        ),
      ),
    );
    expect(result.ok && result.spans[0].payload).toMatchObject({
      inputTokens: 10_050,
      cachedInputTokens: 8000,
      cacheWriteInputTokens: 2000,
    });
  });

  it("adds cache traffic back when it was reported outside input_tokens", () => {
    // Anthropic-style: 50 uncached input tokens, cache counted separately.
    const result = genAiUsageFromOtlp(
      exportOf(
        span(
          "e2",
          ["gen_ai.provider.name", "anthropic"],
          ["gen_ai.usage.input_tokens", 50],
          ["gen_ai.usage.output_tokens", 400],
          ["gen_ai.usage.cache_read.input_tokens", 8000],
          ["gen_ai.usage.cache_creation.input_tokens", 2000],
        ),
      ),
    );
    expect(result.ok && result.spans[0].payload.inputTokens).toBe(10_050);
  });

  it("accepts ints as JSON numbers and falls back to the start time", () => {
    const result = genAiUsageFromOtlp(
      exportOf({
        traceId: "t",
        spanId: "f1",
        startTimeUnixNano: START,
        attributes: [
          { key: "gen_ai.usage.input_tokens", value: { intValue: 7 } },
          { key: "gen_ai.usage.output_tokens", value: { intValue: 3 } },
        ],
      }),
    );
    expect(result.ok && result.spans[0].payload).toMatchObject({
      inputTokens: 7,
      outputTokens: 3,
      occurredAt: "2026-11-02T10:00:00.000Z",
    });
  });

  it.each([
    ["null", null],
    ["an array", []],
    ["an object without resourceSpans", { spans: [] }],
  ])("rejects %s", (_, body) => {
    expect(genAiUsageFromOtlp(body).ok).toBe(false);
  });

  it("tolerates missing optional structure", () => {
    expect(
      genAiUsageFromOtlp({
        resourceSpans: [{}, { scopeSpans: [{}] }, { scopeSpans: null }],
      }),
    ).toEqual({ ok: true, spans: [], skipped: 0 });
  });
});

describe("attribution from span and resource attributes", () => {
  const withResource = (resource: Attr[], ...spans: unknown[]) => ({
    resourceSpans: [
      {
        resource: { attributes: attrs(...resource) },
        scopeSpans: [{ spans }],
      },
    ],
  });
  const usage: Attr[] = [
    ["gen_ai.provider.name", "openai"],
    ["gen_ai.request.model", "gpt-4.1"],
    ["gen_ai.usage.input_tokens", 10],
    ["gen_ai.usage.output_tokens", 5],
  ];
  const payloadOf = (body: unknown) => {
    const result = genAiUsageFromOtlp(body);
    if (!result.ok) throw new Error("expected ok");
    return result.spans[0].payload;
  };

  it("reads the cost_tracker.* attributes and the standard user.id", () => {
    expect(
      payloadOf(
        exportOf(
          span(
            "g1",
            ...usage,
            ["cost_tracker.customer_id", "cus_42"],
            ["cost_tracker.feature", "support-chat"],
            ["cost_tracker.run_id", "run_9"],
            ["user.id", "u_7"],
          ),
        ),
      ),
    ).toMatchObject({
      customerId: "cus_42",
      feature: "support-chat",
      runId: "run_9",
      userId: "u_7",
    });
  });

  it("falls back to resource attributes; the span wins", () => {
    const payload = payloadOf(
      withResource(
        [
          ["cost_tracker.feature", "summaries"],
          ["cost_tracker.customer_id", "from-resource"],
        ],
        span("g2", ...usage, ["cost_tracker.customer_id", "cus_42"]),
      ),
    );
    expect(payload).toMatchObject({
      feature: "summaries",
      customerId: "cus_42",
    });
  });

  it("prefers cost_tracker.user_id, then user.id, then the deprecated enduser.id", () => {
    const userOf = (...pairs: Attr[]) =>
      payloadOf(exportOf(span("g3", ...usage, ...pairs))).userId;
    expect(userOf(["enduser.id", "old"])).toBe("old");
    expect(userOf(["enduser.id", "old"], ["user.id", "new"])).toBe("new");
    expect(
      userOf(["user.id", "new"], ["cost_tracker.user_id", "explicit"]),
    ).toBe("explicit");
  });

  it("drops values the API would reject but keeps the span's usage", () => {
    const payload = payloadOf(
      exportOf(
        span(
          "g4",
          ...usage,
          ["cost_tracker.customer_id", "c".repeat(201)],
          ["cost_tracker.feature", "   "],
          ["cost_tracker.run_id", 42],
        ),
      ),
    );
    expect(payload).not.toHaveProperty("customerId");
    expect(payload).not.toHaveProperty("feature");
    expect(payload).not.toHaveProperty("runId");
    expect(payload.inputTokens).toBe(10);
    expect(
      parseUsagePayload(payload, new Date("2026-11-02T12:00:00Z")).ok,
    ).toBe(true);
  });
});
