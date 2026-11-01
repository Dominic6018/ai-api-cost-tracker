/**
 * AI API Cost Tracker client: reports token usage to `POST /api/usage`.
 *
 * Dependency-free. Copy this file into your project, or import it directly
 * from Node 22.18+ (which runs TypeScript) or any bundler. Only the token
 * counts are sent, never prompts or responses.
 *
 *   const tracker = createCostTracker({ baseUrl, apiKey });
 *   const reply = await tracker.track(openai.responses.create({ ... }));
 *   await tracker.flush(); // before a serverless function returns
 */

export type Provider = "openai" | "anthropic" | "google" | "mistral" | "other";

/** One request's usage, as `POST /api/usage` takes it. */
export interface Usage {
  provider: Provider;
  model: string;
  /** All input tokens, including cached and cache-write tokens. */
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  /** The provider's ID for the request; makes retries safe. */
  requestId?: string;
  occurredAt?: string | Date;
  metadata?: Record<string, unknown>;
}

export interface RecordResult {
  /** The stored cost in USD, as an exact decimal string. */
  costUsd: string;
  /** True when this request ID was already recorded. */
  replayed: boolean;
}

export interface CostTrackerOptions {
  /** Where the tracker runs, e.g. https://costs.example.com */
  baseUrl: string;
  /** A project API key (`act_...`). */
  apiKey: string;
  /** Called when reporting tracked usage fails. Defaults to console.warn. */
  onError?: (error: unknown, usage: Usage | null) => void;
  /** Per attempt; defaults to 10 seconds. */
  timeoutMs?: number;
  /** Retries after a network error, 429 or 5xx; defaults to 2. */
  retries?: number;
  fetch?: typeof fetch;
}

export interface TrackOptions {
  /**
   * The model to price, when the response names a different one. OpenAI
   * responses name dated snapshots (gpt-4.1-2025-04-14), which need their
   * own price unless you record the alias you requested.
   */
  model?: string;
  /** For OpenAI-compatible APIs, such as Mistral's. */
  provider?: Provider;
  metadata?: Record<string, unknown>;
}

/** A rejected or failed `POST /api/usage`. */
export class CostTrackerError extends Error {
  readonly status: number | null;
  readonly code: string | null;
  constructor(message: string, status: number | null, code: string | null) {
    super(message);
    this.name = "CostTrackerError";
    this.status = status;
    this.code = code;
  }
}

// Loose shapes of the provider responses, so no SDK is needed.
type Num = number | null | undefined;
interface AnyResponse {
  id?: string;
  object?: string;
  type?: string;
  model?: string;
  usage?: Record<string, unknown> | null;
  usageMetadata?: Record<string, unknown> | null;
  responseId?: string;
  modelVersion?: string;
}

const n = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;
const details = (value: unknown): Record<string, Num> =>
  (value && typeof value === "object" ? value : {}) as Record<string, Num>;

/** OpenAI Chat Completions: cached tokens are part of `prompt_tokens`. */
export function usageFromOpenAIChat(response: AnyResponse): Usage | null {
  const usage = response.usage;
  if (!usage || typeof usage.prompt_tokens !== "number") return null;
  return {
    provider: "openai",
    model: response.model ?? "",
    inputTokens: n(usage.prompt_tokens),
    // Includes reasoning tokens, which are billed as output.
    outputTokens: n(usage.completion_tokens),
    cachedInputTokens: n(details(usage.prompt_tokens_details).cached_tokens),
    requestId: response.id,
  };
}

/** OpenAI Responses API: cached tokens are part of `input_tokens`. */
export function usageFromOpenAIResponse(response: AnyResponse): Usage | null {
  const usage = response.usage;
  if (!usage || typeof usage.input_tokens !== "number") return null;
  return {
    provider: "openai",
    model: response.model ?? "",
    inputTokens: n(usage.input_tokens),
    outputTokens: n(usage.output_tokens),
    cachedInputTokens: n(details(usage.input_tokens_details).cached_tokens),
    requestId: response.id,
  };
}

/**
 * Anthropic Messages: `input_tokens` excludes cache reads and writes, so
 * they're added back to give the total input the tracker expects.
 */
export function usageFromAnthropic(response: AnyResponse): Usage | null {
  const usage = response.usage;
  if (!usage || typeof usage.input_tokens !== "number") return null;
  const cacheRead = n(usage.cache_read_input_tokens);
  const cacheWrite = n(usage.cache_creation_input_tokens);
  return {
    provider: "anthropic",
    model: response.model ?? "",
    inputTokens: n(usage.input_tokens) + cacheRead + cacheWrite,
    outputTokens: n(usage.output_tokens),
    cachedInputTokens: cacheRead,
    cacheWriteInputTokens: cacheWrite,
    requestId: response.id,
  };
}

/**
 * Gemini `generateContent`: `promptTokenCount` already includes cached
 * content. Thinking tokens are billed as output, and tool-use prompt
 * tokens as input, so both are added in.
 */
export function usageFromGemini(response: AnyResponse): Usage | null {
  const usage = response.usageMetadata;
  if (!usage || typeof usage.promptTokenCount !== "number") return null;
  return {
    provider: "google",
    model: response.modelVersion ?? "",
    inputTokens: n(usage.promptTokenCount) + n(usage.toolUsePromptTokenCount),
    outputTokens: n(usage.candidatesTokenCount) + n(usage.thoughtsTokenCount),
    cachedInputTokens: n(usage.cachedContentTokenCount),
    requestId: response.responseId,
  };
}

/**
 * Reads usage from a response of any supported API, or returns null when
 * the response has none (e.g. a stream without usage reporting).
 */
export function usageFromResponse(response: unknown): Usage | null {
  if (!response || typeof response !== "object") return null;
  const r = response as AnyResponse;
  if (r.usageMetadata) return usageFromGemini(r);
  if (r.type === "message") return usageFromAnthropic(r);
  if (r.object === "response") return usageFromOpenAIResponse(r);
  if (r.object === "chat.completion") return usageFromOpenAIChat(r);
  return null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function createCostTracker(options: CostTrackerOptions) {
  const endpoint = new URL("/api/usage", options.baseUrl).toString();
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const retries = options.retries ?? 2;
  const onError =
    options.onError ??
    ((error: unknown) =>
      console.warn("[cost-tracker] usage not recorded:", error));
  const pending = new Set<Promise<void>>();

  /** Sends one usage record. Throws CostTrackerError if it isn't stored. */
  async function record(usage: Usage): Promise<RecordResult> {
    const body = JSON.stringify({
      ...usage,
      occurredAt:
        usage.occurredAt instanceof Date
          ? usage.occurredAt.toISOString()
          : usage.occurredAt,
    });
    // Without a request ID a retry could store the usage twice.
    const attempts = usage.requestId ? retries + 1 : 1;
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) await sleep(250 * 4 ** (attempt - 1));
      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          method: "POST",
          headers: {
            authorization: `Bearer ${options.apiKey}`,
            "content-type": "application/json",
          },
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        lastError = error;
        continue;
      }
      const json = (await response.json().catch(() => null)) as {
        event?: { costUsd: string };
        replayed?: boolean;
        error?: { code?: string; message?: string };
      } | null;
      if (response.ok && json?.event) {
        return {
          costUsd: json.event.costUsd,
          replayed: Boolean(json.replayed),
        };
      }
      lastError = new CostTrackerError(
        json?.error?.message ?? `HTTP ${response.status}`,
        response.status,
        json?.error?.code ?? null,
      );
      if (response.status !== 429 && response.status < 500) break;
    }
    throw lastError instanceof CostTrackerError
      ? lastError
      : new CostTrackerError(
          `Could not reach the cost tracker: ${String(lastError)}`,
          null,
          null,
        );
  }

  /**
   * Awaits a provider response, reports its usage in the background and
   * returns the response unchanged. Provider errors propagate as usual;
   * reporting errors go to `onError` and never reach the caller.
   */
  async function track<T>(
    responseOrPromise: T | Promise<T>,
    trackOptions: TrackOptions = {},
  ): Promise<T> {
    const response = await responseOrPromise;
    const usage = usageFromResponse(response);
    if (!usage) {
      onError(new CostTrackerError("No usage in response", null, null), null);
      return response;
    }
    const tracked: Usage = {
      ...usage,
      model: trackOptions.model ?? usage.model,
      provider: trackOptions.provider ?? usage.provider,
      metadata: trackOptions.metadata,
    };
    const report = record(tracked).then(
      () => {},
      (error: unknown) => onError(error, tracked),
    );
    pending.add(report);
    void report.finally(() => pending.delete(report));
    return response;
  }

  /** Waits for every background report, e.g. before a function exits. */
  async function flush(): Promise<void> {
    await Promise.all(pending);
  }

  return { record, track, flush };
}

export type CostTracker = ReturnType<typeof createCostTracker>;
