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

/**
 * How the request was processed: "batch" for a provider's discounted Batch
 * API (Anthropic: 50%), or "flex" or "fast" for those processing tiers,
 * which are billed at their own prices.
 */
export type ServiceTier = "standard" | "batch" | "flex" | "fast";

/**
 * Who and what the usage is for, beyond the API key's project. Each is an
 * ID you choose, up to 200 characters; the dashboard filters by them.
 */
export interface Attribution {
  customerId?: string;
  /** The end user in your app. */
  userId?: string;
  feature?: string;
  /** One agent run or workflow. */
  runId?: string;
}

const ATTRIBUTION_KEYS = ["customerId", "userId", "feature", "runId"] as const;

/** `usage`'s own attribution, with `defaults` filling the gaps. */
function withDefaults<T extends Attribution>(
  usage: T,
  defaults: Attribution,
): T {
  const merged = { ...usage };
  for (const key of ATTRIBUTION_KEYS) {
    const value = usage[key] ?? defaults[key];
    if (value === undefined) delete merged[key];
    else merged[key] = value;
  }
  return merged;
}

/**
 * Free-form labels such as `{ env: "prod", team: "search" }`: up to 20,
 * keys of letters, digits and `_ . / -` (not an attribution name), values
 * up to 200 characters. The dashboard filters by them.
 */
export type Tags = Record<string, string>;

/** What a scoped tracker adds: attribution, plus tags for usage. */
export interface Scope extends Attribution {
  tags?: Tags;
}

/** `tags` over `defaults`, key by key; undefined when both are empty. */
function mergeTags(defaults?: Tags, tags?: Tags): Tags | undefined {
  const merged = { ...defaults, ...tags };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/** `usage` with a scope's attribution and tags filling the gaps. */
function usageWithDefaults(usage: Usage, defaults: Scope): Usage {
  const merged = withDefaults(usage, defaults);
  const tags = mergeTags(defaults.tags, usage.tags);
  if (tags) merged.tags = tags;
  else delete merged.tags;
  return merged;
}

/** One request's usage, as `POST /api/usage` takes it. */
export interface Usage extends Attribution {
  provider: Provider;
  model: string;
  /** All input tokens, including cached and cache-write tokens. */
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  /**
   * The part of cacheWriteInputTokens written with a 1-hour TTL, which
   * Anthropic bills at a higher rate than 5-minute writes.
   */
  cacheWrite1hInputTokens?: number;
  /** Defaults to "standard"; "batch" for Batch API results. */
  serviceTier?: ServiceTier;
  /**
   * Server-side web searches the request ran, charged per 1,000 on top of
   * tokens (Anthropic: $10). Needs a web search price for the model.
   */
  webSearchRequests?: number;
  /** The provider's ID for the request; makes retries safe. */
  requestId?: string;
  occurredAt?: string | Date;
  metadata?: Record<string, unknown>;
  tags?: Tags;
}

/**
 * A business result, such as a resolved ticket, for cost per outcome on
 * the dashboard. Attribute it like usage, so a customer's cost is divided
 * by that customer's outcomes.
 */
export interface Outcome extends Attribution {
  /** Lowercase words joined by _ . or -, e.g. "ticket_resolved". */
  name: string;
  /** Defaults to 1; up to 1,000,000 for a batch. */
  count?: number;
  /** Your ID for the outcome; makes retries safe. */
  outcomeId?: string;
  occurredAt?: string | Date;
}

export interface OutcomeResult {
  /** The stored outcome's ID. */
  id: string;
  /** True when this outcome ID was already recorded. */
  replayed: boolean;
}

/** One cap in a budget check. Amounts are exact decimal strings. */
export interface BudgetCap {
  /** Null when no cap is set, which never denies. */
  capUsd: string | null;
  spentUsd: string;
  /** Negative when over the cap; null without a cap. */
  remainingUsd: string | null;
  allowed: boolean;
}

/** The answer to `checkBudget()`. */
export interface BudgetCheck {
  allowed: boolean;
  /** Why it was denied; empty when allowed. */
  reasons: Array<"monthly_budget" | "run_budget">;
  estimatedCostUsd: string;
  /** This UTC month against the project's monthly budget. */
  month: BudgetCap & { period: string };
  /** The run against the project's run budget; null without a runId. */
  run: (BudgetCap & { runId: string }) | null;
}

export interface BudgetCheckOptions {
  /**
   * What the next step might cost, in USD: a decimal string ("0.25") or
   * a number, with up to 6 decimals. Defaults to 0.
   */
  estimatedCostUsd?: string | number;
  /** The agent run; defaults to a scoped tracker's runId. */
  runId?: string;
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

export interface TrackOptions extends Attribution {
  /**
   * The model to price, when the response names a different one. OpenAI
   * responses name dated snapshots (gpt-4.1-2025-04-14), which need their
   * own price unless you record the alias you requested.
   */
  model?: string;
  /** For OpenAI-compatible APIs, such as Mistral's. */
  provider?: Provider;
  metadata?: Record<string, unknown>;
  /** "batch" when the response came from a Batch API. */
  serviceTier?: ServiceTier;
  /** Merged over a scoped tracker's tags, key by key. */
  tags?: Tags;
}

export interface CostTracker {
  /** Sends one usage record. Throws CostTrackerError if it isn't stored. */
  record(usage: Usage): Promise<RecordResult>;
  /**
   * Records one outcome. Throws CostTrackerError if it isn't stored.
   * Retried after network errors, 429s and 5xx only with an outcomeId.
   */
  recordOutcome(outcome: Outcome): Promise<OutcomeResult>;
  /**
   * Awaits a provider response, reports its usage in the background and
   * returns the response unchanged. Provider errors propagate as usual;
   * reporting errors go to `onError` and never reach the caller.
   */
  track<T>(
    responseOrPromise: T | Promise<T>,
    options?: TrackOptions,
  ): Promise<T>;
  /**
   * Asks whether the project may spend `estimatedCostUsd` now, under its
   * monthly budget and, given a run ID, its run budget. A denial is a
   * result with `allowed: false`, not an error; failures throw
   * CostTrackerError, so decide whether to fail open or closed. Retried
   * after network errors, 429s and 5xx, since a check changes nothing.
   */
  checkBudget(options?: BudgetCheckOptions): Promise<BudgetCheck>;
  /** Waits for every background report, e.g. before a function exits. */
  flush(): Promise<void>;
  /**
   * A tracker that adds this attribution to everything it records, e.g.
   * `tracker.with({ customerId })` once per request, and these tags to
   * its usage (outcomes have no tags). Values passed to `record` or
   * `track` win, tags key by key; `flush` waits for every tracker.
   */
  with(scope: Scope): CostTracker;
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
  // `cache_creation` splits the writes by TTL; 1-hour writes cost more.
  const cacheWrite1h = Math.min(
    n(details(usage.cache_creation).ephemeral_1h_input_tokens),
    cacheWrite,
  );
  // Billed per search, apart from tokens; sent only when there were any.
  const searches = n(details(usage.server_tool_use).web_search_requests);
  return {
    provider: "anthropic",
    model: response.model ?? "",
    inputTokens: n(usage.input_tokens) + cacheRead + cacheWrite,
    outputTokens: n(usage.output_tokens),
    cachedInputTokens: cacheRead,
    cacheWriteInputTokens: cacheWrite,
    cacheWrite1hInputTokens: cacheWrite1h,
    ...(searches > 0 && { webSearchRequests: searches }),
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

export function createCostTracker(options: CostTrackerOptions): CostTracker {
  const url = (path: string) => new URL(path, options.baseUrl).toString();
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const retries = options.retries ?? 2;
  const onError =
    options.onError ??
    ((error: unknown) =>
      console.warn("[cost-tracker] usage not recorded:", error));
  const pending = new Set<Promise<void>>();

  /**
   * POSTs a JSON body and returns the parsed response. Network errors, 429s
   * and 5xx are retried only when `retryable`, i.e. when the body carries
   * an ID that keeps a retry from being stored twice.
   */
  async function post(
    path: string,
    payload: object & { occurredAt?: string | Date },
    retryable: boolean,
  ): Promise<Record<string, unknown>> {
    const body = JSON.stringify({
      ...payload,
      occurredAt:
        payload.occurredAt instanceof Date
          ? payload.occurredAt.toISOString()
          : payload.occurredAt,
    });
    const attempts = retryable ? retries + 1 : 1;
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) await sleep(250 * 4 ** (attempt - 1));
      let response: Response;
      try {
        response = await fetchImpl(url(path), {
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
      const json = (await response.json().catch(() => null)) as Record<
        string,
        unknown
      > | null;
      if (response.ok && json) return json;
      const error = (json?.error ?? {}) as { code?: string; message?: string };
      lastError = new CostTrackerError(
        error.message ?? `HTTP ${response.status}`,
        response.status,
        error.code ?? null,
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

  async function send(usage: Usage): Promise<RecordResult> {
    // Without a request ID a retry could store the usage twice.
    const json = await post("/api/usage", usage, Boolean(usage.requestId));
    const event = json.event as { costUsd?: string } | undefined;
    if (!event?.costUsd) {
      throw new CostTrackerError("Unexpected response", null, null);
    }
    return { costUsd: event.costUsd, replayed: Boolean(json.replayed) };
  }

  async function sendOutcome(outcome: Outcome): Promise<OutcomeResult> {
    const json = await post(
      "/api/outcomes",
      outcome,
      Boolean(outcome.outcomeId),
    );
    const stored = json.outcome as { id?: string } | undefined;
    if (!stored?.id) {
      throw new CostTrackerError("Unexpected response", null, null);
    }
    return { id: stored.id, replayed: Boolean(json.replayed) };
  }

  async function checkBudget(
    options: BudgetCheckOptions,
    defaults: Scope,
  ): Promise<BudgetCheck> {
    const runId = options.runId ?? defaults.runId;
    const json = await post(
      "/api/budget/check",
      {
        ...(options.estimatedCostUsd !== undefined && {
          estimatedCostUsd: options.estimatedCostUsd,
        }),
        ...(runId !== undefined && { runId }),
      },
      // A check is read-only, so a retry can't change anything.
      true,
    );
    if (typeof json.allowed !== "boolean" || !json.month) {
      throw new CostTrackerError("Unexpected response", null, null);
    }
    return json as unknown as BudgetCheck;
  }

  async function track<T>(
    responseOrPromise: T | Promise<T>,
    trackOptions: TrackOptions,
    defaults: Scope,
  ): Promise<T> {
    const response = await responseOrPromise;
    const usage = usageFromResponse(response);
    if (!usage) {
      onError(new CostTrackerError("No usage in response", null, null), null);
      return response;
    }
    const { model, provider, metadata, tags, serviceTier, ...attribution } =
      trackOptions;
    const tracked = usageWithDefaults(
      {
        ...usage,
        ...attribution,
        model: model ?? usage.model,
        provider: provider ?? usage.provider,
        metadata,
        tags,
        ...(serviceTier && { serviceTier }),
      },
      defaults,
    );
    const report = send(tracked).then(
      () => {},
      (error: unknown) => onError(error, tracked),
    );
    pending.add(report);
    void report.finally(() => pending.delete(report));
    return response;
  }

  async function flush(): Promise<void> {
    await Promise.all(pending);
  }

  // Every scoped tracker shares one connection setup and pending set.
  function scoped(defaults: Scope): CostTracker {
    return {
      record: (usage) => send(usageWithDefaults(usage, defaults)),
      // Attribution only: the outcomes API takes no tags.
      recordOutcome: (outcome) => sendOutcome(withDefaults(outcome, defaults)),
      track: (responseOrPromise, trackOptions = {}) =>
        track(responseOrPromise, trackOptions, defaults),
      checkBudget: (options = {}) => checkBudget(options, defaults),
      flush,
      with: ({ tags, ...attribution }) =>
        scoped({
          ...withDefaults(attribution, defaults),
          tags: mergeTags(defaults.tags, tags),
        }),
    };
  }

  return scoped({});
}
