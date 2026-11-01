import { describe, expect, it, vi } from "vitest";
import { calculateCostUsd } from "@/lib/cost";
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
      requestId: "msg_01abc",
    });
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
