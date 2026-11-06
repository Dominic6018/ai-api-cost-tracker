import { describe, expect, it, vi } from "vitest";
import { calculateCostUsd } from "@/lib/cost";
import { budgetCheckPayloadSchema } from "@/lib/budget-check";
import { usagePayloadSchema } from "@/lib/usage";
import {
  CostTrackerError,
  createCostTracker,
  usageFromResponse,
  type Usage,
} from "./cost-tracker";

// Response bodies trimmed to the fields that matter, in each API's shape.
const openAIChat = {
  id: "chatcmpl-abc123",
  object: "chat.completion",
  model: "gpt-4.1-2025-04-14",
  choices: [],
  usage: {
    prompt_tokens: 1200,
    completion_tokens: 300,
    total_tokens: 1500,
    prompt_tokens_details: { cached_tokens: 1024, audio_tokens: 0 },
    completion_tokens_details: { reasoning_tokens: 0 },
  },
};

const openAIResponse = {
  id: "resp_abc123",
  object: "response",
  model: "gpt-5.4-mini",
  output: [],
  usage: {
    input_tokens: 2000,
    input_tokens_details: { cached_tokens: 512 },
    output_tokens: 700,
    output_tokens_details: { reasoning_tokens: 400 },
    total_tokens: 2700,
  },
};

const anthropic = {
  id: "msg_01abc",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-5-5",
  content: [],
  usage: {
    input_tokens: 50,
    cache_creation_input_tokens: 2000,
    cache_read_input_tokens: 8000,
    output_tokens: 400,
  },
};

const gemini = {
  responseId: "gemini-response-1",
  modelVersion: "gemini-2.5-pro",
  candidates: [],
  usageMetadata: {
    promptTokenCount: 5000,
    cachedContentTokenCount: 4000,
    candidatesTokenCount: 300,
    toolUsePromptTokenCount: 120,
    thoughtsTokenCount: 900,
    totalTokenCount: 6320,
  },
};

describe("usageFromResponse", () => {
  it("maps OpenAI Chat Completions; cached tokens stay inside input", () => {
    expect(usageFromResponse(openAIChat)).toEqual({
      provider: "openai",
      model: "gpt-4.1-2025-04-14",
      inputTokens: 1200,
      outputTokens: 300,
      cachedInputTokens: 1024,
      requestId: "chatcmpl-abc123",
    });
  });

  it("maps the OpenAI Responses API; reasoning is already in output", () => {
    expect(usageFromResponse(openAIResponse)).toEqual({
      provider: "openai",
      model: "gpt-5.4-mini",
      inputTokens: 2000,
      outputTokens: 700,
      cachedInputTokens: 512,
      requestId: "resp_abc123",
    });
  });

  it("maps Anthropic, adding cache reads and writes back into input", () => {
    expect(usageFromResponse(anthropic)).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-5-5",
      inputTokens: 10_050,
      outputTokens: 400,
      cachedInputTokens: 8000,
      cacheWriteInputTokens: 2000,
      // No cache_creation breakdown: every write is a 5-minute write.
      cacheWrite1hInputTokens: 0,
      requestId: "msg_01abc",
    });
  });

  it("reads Anthropic's 1-hour cache writes from cache_creation", () => {
    const withTtl = {
      ...anthropic,
      usage: {
        ...anthropic.usage,
        cache_creation: {
          ephemeral_5m_input_tokens: 500,
          ephemeral_1h_input_tokens: 1500,
        },
      },
    };
    expect(usageFromResponse(withTtl)).toMatchObject({
      cacheWriteInputTokens: 2000,
      cacheWrite1hInputTokens: 1500,
    });
    // Priced at Sonnet 5.5's rates: 50 × $2 + 8,000 × $0.10 + 500 × $2.50
    // + 1,500 × $4 + 400 × $10 = $0.01215
    const usage = usageFromResponse(withTtl)!;
    expect(usagePayloadSchema.safeParse(usage).success).toBe(true);
    expect(
      calculateCostUsd(usage, {
        inputPerMTokUsd: 2,
        outputPerMTokUsd: 10,
        cachedInputPerMTokUsd: 0.1,
        cacheWritePerMTokUsd: 2.5,
        cacheWrite1hPerMTokUsd: 4,
      }),
    ).toBe(0.01215);
  });

  it("reads Anthropic's web searches from server_tool_use", () => {
    const searched = {
      ...anthropic,
      usage: {
        ...anthropic.usage,
        server_tool_use: { web_search_requests: 3 },
      },
    };
    const usage = usageFromResponse(searched)!;
    expect(usage.webSearchRequests).toBe(3);
    expect(usagePayloadSchema.safeParse(usage).success).toBe(true);
    // Without searches the field is left out, as before.
    expect(usageFromResponse(anthropic)).not.toHaveProperty(
      "webSearchRequests",
    );
    expect(
      usageFromResponse({
        ...anthropic,
        usage: {
          ...anthropic.usage,
          server_tool_use: { web_search_requests: 0 },
        },
      }),
    ).not.toHaveProperty("webSearchRequests");
  });

  it("maps Gemini, billing thinking as output and tool-use prompts as input", () => {
    expect(usageFromResponse(gemini)).toEqual({
      provider: "google",
      model: "gemini-2.5-pro",
      inputTokens: 5120,
      outputTokens: 1200,
      cachedInputTokens: 4000,
      requestId: "gemini-response-1",
    });
  });

  it("treats missing optional counts as zero", () => {
    expect(
      usageFromResponse({
        ...anthropic,
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_creation_input_tokens: null,
          cache_read_input_tokens: null,
        },
      }),
    ).toMatchObject({
      inputTokens: 10,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
    });
    expect(
      usageFromResponse({
        ...openAIChat,
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    ).toMatchObject({ inputTokens: 10, cachedInputTokens: 0 });
  });

  it.each([
    ["null", null],
    ["a string", "hello"],
    ["a stream chunk", { object: "chat.completion.chunk", choices: [] }],
    ["a response without usage", { ...openAIChat, usage: undefined }],
    ["an unknown shape", { foo: 1 }],
  ])("returns null for %s", (_, response) => {
    expect(usageFromResponse(response)).toBeNull();
  });

  it("produces payloads the API accepts", () => {
    for (const response of [openAIChat, openAIResponse, anthropic, gemini]) {
      const usage = usageFromResponse(response)!;
      expect(usagePayloadSchema.safeParse(usage).success).toBe(true);
    }
  });

  it("prices Anthropic cache traffic the same as a hand-written payload", () => {
    // Sonnet 5.5-like rates: $3 input, $0.30 cached, $3.75 writes, $15 output.
    const pricing = {
      inputPerMTokUsd: 3,
      cachedInputPerMTokUsd: 0.3,
      cacheWritePerMTokUsd: 3.75,
      outputPerMTokUsd: 15,
      longContext: null,
    };
    const usage = usageFromResponse(anthropic)!;
    // 50 uncached input, 8,000 cache reads, 2,000 writes, 400 output
    const expected = (50 * 3 + 8000 * 0.3 + 2000 * 3.75 + 400 * 15) / 1_000_000;
    expect(
      calculateCostUsd(
        {
          inputTokens: usage.inputTokens,
          cachedInputTokens: usage.cachedInputTokens ?? 0,
          cacheWriteInputTokens: usage.cacheWriteInputTokens ?? 0,
          outputTokens: usage.outputTokens,
        },
        pricing,
      ),
    ).toBeCloseTo(expected, 9);
  });
});

function setup(responses: Array<Response | Error>) {
  const fetch = vi.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    if (next instanceof Error) throw next;
    return next;
  });
  const onError = vi.fn();
  const tracker = createCostTracker({
    baseUrl: "https://costs.example.com/ignored/path",
    apiKey: "act_test",
    fetch: fetch as unknown as typeof globalThis.fetch,
    onError,
  });
  return { tracker, fetch, onError };
}

const stored = (costUsd = "0.001000", replayed = false, status = 201) =>
  Response.json({ event: { costUsd }, replayed }, { status });
const failed = (status: number, code: string) =>
  Response.json({ error: { code, message: `failed: ${code}` } }, { status });

const usage: Usage = {
  provider: "openai",
  model: "gpt-4.1",
  inputTokens: 1000,
  outputTokens: 500,
  requestId: "req_1",
};

describe("record", () => {
  it("posts the usage with the API key and returns the stored cost", async () => {
    const { tracker, fetch } = setup([stored("0.006000")]);
    const at = new Date("2026-11-02T10:00:00Z");
    expect(await tracker.record({ ...usage, occurredAt: at })).toEqual({
      costUsd: "0.006000",
      replayed: false,
    });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://costs.example.com/api/usage");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe(
      "Bearer act_test",
    );
    expect(JSON.parse(init.body as string)).toEqual({
      ...usage,
      occurredAt: "2026-11-02T10:00:00.000Z",
    });
  });

  it("retries network errors, 429s and 5xx when there's a request ID", async () => {
    const { tracker, fetch } = setup([
      new TypeError("fetch failed"),
      failed(503, "unavailable"),
      stored("0.006000", true, 200),
    ]);
    vi.useFakeTimers();
    try {
      const result = tracker.record(usage);
      await vi.runAllTimersAsync();
      expect(await result).toEqual({ costUsd: "0.006000", replayed: true });
      expect(fetch).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("doesn't retry without a request ID, which could store usage twice", async () => {
    const { tracker, fetch } = setup([failed(503, "unavailable")]);
    await expect(
      tracker.record({ ...usage, requestId: undefined }),
    ).rejects.toMatchObject({ status: 503 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("doesn't retry a rejection, and reports its status and code", async () => {
    const { tracker, fetch } = setup([failed(422, "no_pricing")]);
    const error = await tracker.record(usage).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CostTrackerError);
    expect(error).toMatchObject({
      status: 422,
      code: "no_pricing",
      message: "failed: no_pricing",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("track", () => {
  it("returns the response unchanged and reports its usage", async () => {
    const { tracker, fetch, onError } = setup([stored()]);
    const response = await tracker.track(Promise.resolve(anthropic), {
      metadata: { feature: "chat" },
    });
    expect(response).toBe(anthropic);
    await tracker.flush();
    const body = JSON.parse(
      (fetch.mock.calls[0] as unknown as [string, RequestInit])[1]
        .body as string,
    );
    expect(body).toMatchObject({
      provider: "anthropic",
      requestId: "msg_01abc",
      metadata: { feature: "chat" },
    });
    expect(onError).not.toHaveBeenCalled();
  });

  it("lets the caller override the model and provider", async () => {
    const { tracker, fetch } = setup([stored()]);
    await tracker.track(openAIChat, { model: "gpt-4.1", provider: "mistral" });
    await tracker.flush();
    const body = JSON.parse(
      (fetch.mock.calls[0] as unknown as [string, RequestInit])[1]
        .body as string,
    );
    expect(body).toMatchObject({ model: "gpt-4.1", provider: "mistral" });
  });

  it("sends reporting failures to onError, never to the caller", async () => {
    const { tracker, onError } = setup([failed(401, "unauthorized")]);
    await expect(tracker.track(gemini)).resolves.toBe(gemini);
    await tracker.flush();
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ status: 401 }),
      expect.objectContaining({ requestId: "gemini-response-1" }),
    );
  });

  it("reports a response without usage, and still returns it", async () => {
    const { tracker, fetch, onError } = setup([]);
    const chunk = { object: "chat.completion.chunk" };
    expect(await tracker.track(chunk)).toBe(chunk);
    expect(fetch).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "No usage in response" }),
      null,
    );
  });

  it("lets provider errors through untouched", async () => {
    const { tracker, fetch } = setup([]);
    const failure = new Error("rate limited by provider");
    await expect(tracker.track(Promise.reject(failure))).rejects.toBe(failure);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("attribution", () => {
  const bodyOf = (fetch: ReturnType<typeof setup>["fetch"], call = 0) =>
    JSON.parse(
      (fetch.mock.calls[call] as unknown as [string, RequestInit])[1]
        .body as string,
    );

  it("sends customer, user, feature and run from track() options", async () => {
    const { tracker, fetch } = setup([stored()]);
    await tracker.track(anthropic, {
      customerId: "cus_42",
      userId: "u_7",
      feature: "support-chat",
      runId: "run_9",
    });
    await tracker.flush();
    expect(bodyOf(fetch)).toMatchObject({
      customerId: "cus_42",
      userId: "u_7",
      feature: "support-chat",
      runId: "run_9",
    });
  });

  it("adds a scoped tracker's attribution; explicit values win", async () => {
    const { tracker, fetch } = setup([stored(), stored(), stored()]);
    const forCustomer = tracker.with({ customerId: "cus_42", feature: "chat" });
    await forCustomer.track(openAIChat);
    await forCustomer.track(openAIChat, { feature: "search", runId: "r1" });
    await forCustomer.with({ userId: "u_7" }).record(usage);
    // The parent's flush waits for its scoped trackers' reports too.
    await tracker.flush();

    expect(bodyOf(fetch, 0)).toMatchObject({
      customerId: "cus_42",
      feature: "chat",
    });
    expect(bodyOf(fetch, 1)).toMatchObject({
      customerId: "cus_42",
      feature: "search",
      runId: "r1",
    });
    expect(bodyOf(fetch, 2)).toMatchObject({
      customerId: "cus_42",
      feature: "chat",
      userId: "u_7",
      requestId: "req_1",
    });
  });

  it("leaves attribution out entirely when there is none", async () => {
    const { tracker, fetch } = setup([stored()]);
    await tracker.with({}).record(usage);
    const body = bodyOf(fetch);
    for (const key of ["customerId", "userId", "feature", "runId"]) {
      expect(body).not.toHaveProperty(key);
    }
  });

  it("doesn't let a scoped tracker change the parent", async () => {
    const { tracker, fetch } = setup([stored()]);
    tracker.with({ customerId: "cus_42" });
    await tracker.record(usage);
    expect(bodyOf(fetch)).not.toHaveProperty("customerId");
  });
});

describe("tags", () => {
  const bodyOf = (fetch: ReturnType<typeof setup>["fetch"], call = 0) =>
    JSON.parse(
      (fetch.mock.calls[call] as unknown as [string, RequestInit])[1]
        .body as string,
    );

  it("sends tags from record() and track()", async () => {
    const { tracker, fetch } = setup([stored(), stored()]);
    await tracker.record({ ...usage, tags: { env: "prod" } });
    await tracker.track(anthropic, { tags: { team: "search" } });
    await tracker.flush();
    expect(bodyOf(fetch, 0).tags).toEqual({ env: "prod" });
    expect(bodyOf(fetch, 1).tags).toEqual({ team: "search" });
  });

  it("merges scoped tags key by key; the call's own values win", async () => {
    const { tracker, fetch } = setup([stored(), stored(), stored()]);
    const prod = tracker.with({ tags: { env: "prod", team: "core" } });
    const search = prod.with({
      customerId: "cus_42",
      tags: { team: "search" },
    });
    await search.record(usage);
    await search.track(openAIChat, { tags: { env: "canary", ab: "b" } });
    await prod.record({ ...usage, tags: {} });
    await tracker.flush();

    expect(bodyOf(fetch, 0)).toMatchObject({
      customerId: "cus_42",
      tags: { env: "prod", team: "search" },
    });
    expect(bodyOf(fetch, 1).tags).toEqual({
      env: "canary",
      team: "search",
      ab: "b",
    });
    expect(bodyOf(fetch, 2).tags).toEqual({ env: "prod", team: "core" });
  });

  it("leaves tags out when there are none, and off outcomes", async () => {
    const { tracker, fetch } = setup([
      stored(),
      Response.json({ outcome: { id: "out-1" }, replayed: false }),
    ]);
    const scoped = tracker.with({
      customerId: "cus_42",
      tags: { env: "prod" },
    });
    await tracker.with({ tags: {} }).record(usage);
    await scoped.recordOutcome({ name: "ticket_resolved" });
    expect(bodyOf(fetch, 0)).not.toHaveProperty("tags");
    // The outcomes API rejects unknown fields, so tags must stay off.
    expect(bodyOf(fetch, 1)).toEqual({
      name: "ticket_resolved",
      customerId: "cus_42",
    });
  });

  it("produces payloads the API accepts", () => {
    const payload = { ...usage, tags: { env: "prod", "team/search": "a" } };
    expect(usagePayloadSchema.safeParse(payload).success).toBe(true);
  });
});

describe("recordOutcome", () => {
  const storedOutcome = (replayed = false, status = 201) =>
    Response.json(
      { outcome: { id: "out-1", name: "ticket_resolved" }, replayed },
      { status },
    );
  const call = (fetch: ReturnType<typeof setup>["fetch"], n = 0) =>
    fetch.mock.calls[n] as unknown as [string, RequestInit];

  it("posts the outcome to /api/outcomes and returns its ID", async () => {
    const { tracker, fetch } = setup([storedOutcome()]);
    const at = new Date("2026-11-04T09:00:00Z");
    expect(
      await tracker.recordOutcome({
        name: "ticket_resolved",
        outcomeId: "ticket-881",
        occurredAt: at,
      }),
    ).toEqual({ id: "out-1", replayed: false });
    const [url, init] = call(fetch);
    expect(url).toBe("https://costs.example.com/api/outcomes");
    expect(JSON.parse(init.body as string)).toEqual({
      name: "ticket_resolved",
      outcomeId: "ticket-881",
      occurredAt: "2026-11-04T09:00:00.000Z",
    });
  });

  it("adds a scoped tracker's attribution; explicit values win", async () => {
    const { tracker, fetch } = setup([storedOutcome()]);
    await tracker
      .with({ customerId: "cus_42", feature: "chat" })
      .recordOutcome({ name: "ticket_resolved", feature: "email" });
    expect(JSON.parse(call(fetch)[1].body as string)).toEqual({
      name: "ticket_resolved",
      customerId: "cus_42",
      feature: "email",
    });
  });

  it("retries with an outcomeId and reports a replay", async () => {
    const { tracker, fetch } = setup([
      failed(503, "unavailable"),
      storedOutcome(true, 200),
    ]);
    vi.useFakeTimers();
    try {
      const result = tracker.recordOutcome({
        name: "ticket_resolved",
        outcomeId: "ticket-881",
      });
      await vi.runAllTimersAsync();
      expect(await result).toEqual({ id: "out-1", replayed: true });
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("doesn't retry without an outcomeId, which could count it twice", async () => {
    const { tracker, fetch } = setup([failed(503, "unavailable")]);
    await expect(
      tracker.recordOutcome({ name: "ticket_resolved" }),
    ).rejects.toMatchObject({ status: 503 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("throws the API's code for a conflict or an invalid outcome", async () => {
    const { tracker } = setup([failed(409, "outcome_id_conflict")]);
    await expect(
      tracker.recordOutcome({ name: "ticket_resolved", outcomeId: "x" }),
    ).rejects.toMatchObject({ status: 409, code: "outcome_id_conflict" });
  });
});

describe("checkBudget", () => {
  const answer = {
    allowed: false,
    reasons: ["run_budget"],
    estimatedCostUsd: "0.250000",
    month: {
      period: "2026-11",
      capUsd: "100.000000",
      spentUsd: "40.000000",
      remainingUsd: "60.000000",
      allowed: true,
    },
    run: {
      runId: "run_42",
      capUsd: "2.000000",
      spentUsd: "1.900000",
      remainingUsd: "0.100000",
      allowed: false,
    },
  };
  const checked = () => Response.json(answer);
  const call = (fetch: ReturnType<typeof setup>["fetch"], n = 0) =>
    fetch.mock.calls[n] as unknown as [string, RequestInit];
  const bodyOf = (fetch: ReturnType<typeof setup>["fetch"], n = 0) =>
    JSON.parse(call(fetch, n)[1].body as string);

  it("posts the estimate and run, and returns the answer", async () => {
    const { tracker, fetch } = setup([checked()]);
    expect(
      await tracker.checkBudget({ estimatedCostUsd: "0.25", runId: "run_42" }),
    ).toEqual(answer);
    const [url, init] = call(fetch);
    expect(url).toBe("https://costs.example.com/api/budget/check");
    expect(new Headers(init.headers).get("authorization")).toBe(
      "Bearer act_test",
    );
    expect(bodyOf(fetch)).toEqual({
      estimatedCostUsd: "0.25",
      runId: "run_42",
    });
  });

  it("uses a scoped tracker's run unless one is passed", async () => {
    const { tracker, fetch } = setup([checked(), checked(), checked()]);
    const run = tracker.with({ runId: "run_42", customerId: "cus_1" });
    await run.checkBudget({ estimatedCostUsd: 0.25 });
    await run.checkBudget({ runId: "run_other" });
    await tracker.checkBudget();
    // Only the run matters to a check; other attribution isn't sent.
    expect(bodyOf(fetch, 0)).toEqual({
      estimatedCostUsd: 0.25,
      runId: "run_42",
    });
    expect(bodyOf(fetch, 1)).toEqual({ runId: "run_other" });
    expect(bodyOf(fetch, 2)).toEqual({});
  });

  it("sends bodies the API accepts", () => {
    for (const body of [
      {},
      { estimatedCostUsd: "0.25", runId: "run_42" },
      { estimatedCostUsd: 0.25 },
    ]) {
      expect(budgetCheckPayloadSchema.safeParse(body).success).toBe(true);
    }
  });

  it("retries network errors, 429s and 5xx, since a check is read-only", async () => {
    const { tracker, fetch } = setup([
      new TypeError("fetch failed"),
      failed(503, "unavailable"),
      checked(),
    ]);
    vi.useFakeTimers();
    try {
      const result = tracker.checkBudget();
      await vi.runAllTimersAsync();
      expect((await result).allowed).toBe(false);
      expect(fetch).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("throws the API's error, or for an unexpected response", async () => {
    const { tracker } = setup([
      failed(400, "invalid_payload"),
      Response.json({ ok: true }),
    ]);
    await expect(
      tracker.checkBudget({ estimatedCostUsd: "-1" }),
    ).rejects.toMatchObject({ status: 400, code: "invalid_payload" });
    await expect(tracker.checkBudget()).rejects.toThrow("Unexpected response");
  });
});

describe("serviceTier", () => {
  const bodyOf = (fetch: ReturnType<typeof setup>["fetch"], call = 0) =>
    JSON.parse(
      (fetch.mock.calls[call] as unknown as [string, RequestInit])[1]
        .body as string,
    );

  it("sends batch usage from record() and track()", async () => {
    const { tracker, fetch } = setup([stored(), stored(), stored()]);
    await tracker.record({ ...usage, serviceTier: "batch" });
    await tracker.track(anthropic, { serviceTier: "batch" });
    await tracker.track(anthropic);
    await tracker.flush();
    expect(bodyOf(fetch, 0).serviceTier).toBe("batch");
    expect(bodyOf(fetch, 1).serviceTier).toBe("batch");
    // Standard is the server's default, so nothing is sent.
    expect(bodyOf(fetch, 2)).not.toHaveProperty("serviceTier");
  });

  it("produces payloads the API accepts", () => {
    expect(
      usagePayloadSchema.safeParse({ ...usage, serviceTier: "batch" }).success,
    ).toBe(true);
  });
});
