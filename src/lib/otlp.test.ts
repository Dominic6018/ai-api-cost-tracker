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

  it("uses the provider's response ID, so clients and spans match", () => {
    const withId = span(
      "aaa19b7ec3c1b174",
      ["gen_ai.provider.name", "anthropic"],
      ["gen_ai.request.model", "claude-sonnet-5-5"],
      ["gen_ai.response.id", "msg_01XFDUDYJgAACzvnptvVoYEL"],
      ["gen_ai.usage.input_tokens", 10],
      ["gen_ai.usage.output_tokens", 5],
    );
    const tooLong = span(
      "bbb19b7ec3c1b174",
      ["gen_ai.provider.name", "anthropic"],
      ["gen_ai.request.model", "claude-sonnet-5-5"],
      ["gen_ai.response.id", "x".repeat(201)],
      ["gen_ai.usage.input_tokens", 10],
      ["gen_ai.usage.output_tokens", 5],
    );
    const result = genAiUsageFromOtlp(exportOf(withId, tooLong));
    if (!result.ok) throw new Error("expected spans");
    expect(result.spans.map((s) => s.payload.requestId)).toEqual([
      "msg_01XFDUDYJgAACzvnptvVoYEL",
      "otel:5b8efff798038103d269b633813fc60c:bbb19b7ec3c1b174",
    ]);
    // The trace and span stay in the metadata either way.
    expect(result.spans[0].payload.metadata).toMatchObject({
      spanId: "aaa19b7ec3c1b174",
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

describe("tags from cost_tracker.tag.* attributes", () => {
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
  const now = new Date("2026-11-02T12:00:00Z");

  it("reads the prefix as tags; numbers and booleans become strings", () => {
    const payload = payloadOf(
      exportOf(
        span(
          "t1",
          ...usage,
          ["cost_tracker.tag.env", " prod "],
          ["cost_tracker.tag.team.name", "search"],
          ["cost_tracker.tag.version", 2],
          ["cost_tracker.tag.beta", true],
          ["cost_tracker.feature", "chat"],
        ),
      ),
    );
    expect(payload.tags).toEqual({
      env: "prod",
      "team.name": "search",
      version: "2",
      beta: "true",
    });
    expect(payload.feature).toBe("chat");
    const parsed = parseUsagePayload(payload, now);
    expect(parsed.ok && parsed.usage.tags).toEqual(payload.tags);
  });

  it("falls back to resource attributes key by key; the span wins", () => {
    const payload = payloadOf(
      withResource(
        [
          ["cost_tracker.tag.env", "prod"],
          ["cost_tracker.tag.region", "eu"],
        ],
        span("t2", ...usage, ["cost_tracker.tag.env", "canary"]),
      ),
    );
    expect(payload.tags).toEqual({ env: "canary", region: "eu" });
  });

  it("leaves tags out when there are none", () => {
    expect(payloadOf(exportOf(span("t3", ...usage)))).not.toHaveProperty(
      "tags",
    );
  });

  it("drops tags the API would reject but keeps the span's usage", () => {
    const payload = payloadOf(
      exportOf(
        span(
          "t4",
          ...usage,
          ["cost_tracker.tag.", "no key"],
          ["cost_tracker.tag.my tag", "space"],
          ["cost_tracker.tag.k8s:ns", "colon"],
          ["cost_tracker.tag.customerId", "reserved"],
          ["cost_tracker.tag.empty", "  "],
          ["cost_tracker.tag.long", "v".repeat(201)],
          ["cost_tracker.tag.ok", "kept"],
        ),
      ),
    );
    expect(payload.tags).toEqual({ ok: "kept" });
    expect(parseUsagePayload(payload, now).ok).toBe(true);
  });

  it("keeps a constructor tag and drops __proto__, as the API does", () => {
    const payload = payloadOf(
      exportOf(
        span(
          "t6",
          ...usage,
          ["cost_tracker.tag.constructor", "a"],
          ["cost_tracker.tag.__proto__", "b"],
        ),
      ),
    );
    expect(payload.tags).toEqual({ constructor: "a" });
    expect(Object.getPrototypeOf(payload.tags)).toBe(Object.prototype);
    const parsed = parseUsagePayload(payload, now);
    expect(parsed.ok && parsed.usage.tags).toEqual({ constructor: "a" });
  });

  it("keeps the first 20 valid tags, span before resource", () => {
    const many = (prefix: string, n: number): Attr[] =>
      Array.from({ length: n }, (_, i) => [
        `cost_tracker.tag.${prefix}${i}`,
        "v",
      ]);
    const payload = payloadOf(
      withResource(
        many("r", 5),
        span(
          "t5",
          ...usage,
          ["cost_tracker.tag.bad key", "x"],
          ...many("s", 18),
        ),
      ),
    );
    const tags = payload.tags as Record<string, string>;
    expect(Object.keys(tags)).toHaveLength(20);
    expect(tags).toHaveProperty("s17");
    expect(tags).toHaveProperty("r1");
    expect(tags).not.toHaveProperty("r2");
    expect(parseUsagePayload(payload, now).ok).toBe(true);
  });
});
