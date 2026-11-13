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
  /** The `reserveBudget()` hold this usage settles. */
  reservationId?: string;
  provider: Provider;
  model: string;
  /** All input tokens, including cached and cache-write tokens. */
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  /**
   * The part of cacheWriteInputTokens written with the longer cache
   * lifetime, billed at a higher rate: Anthropic's 1-hour writes or
   * OpenAI's 12-hour writes.
   */
  cacheWrite1hInputTokens?: number;
  /** Defaults to "standard"; "batch" for Batch API results. */
  serviceTier?: ServiceTier;
  /**
   * Server-side web searches the request ran, charged per 1,000 on top of
   * tokens (Anthropic: $10). Needs a web search price for the model.
   */
  webSearchRequests?: number;
  /**
   * Audio tokens, billed at the model's audio rates (OpenAI's audio and
   * realtime models): parts of inputTokens, cachedInputTokens and
   * outputTokens. Needs audio rates for the model.
   */
  audioInputTokens?: number;
  cachedAudioInputTokens?: number;
  audioOutputTokens?: number;
  /**
   * Image tokens (OpenAI's image generation models), billed at the model's
   * image rates, or as text without them: parts of the same totals.
   */
  imageInputTokens?: number;
  cachedImageInputTokens?: number;
  imageOutputTokens?: number;
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
  /** Unexpired reservations, which count like spend. */
  heldUsd: string;
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

/** A hold on part of the budgets, from `reserveBudget()`. */
export interface Reservation {
  reservationId: string;
  /** The amount held, as an exact decimal string. */
  amountUsd: string;
  runId: string | null;
  /** "expired" once past `expiresAt`, when it stops counting. */
  status: "held" | "released" | "settled" | "expired";
  expiresAt: string;
}

/** The answer to `reserveBudget()`: the check, and the hold if allowed. */
export interface BudgetReservation extends BudgetCheck {
  /** Null when denied: nothing is held. */
  reservation: Reservation | null;
  /** True when this reservationId was already used. */
  replayed: boolean;
}

export interface ReserveOptions {
  /**
   * Your ID for the hold, unique per project; retries reuse it. Send the
   * step's usage with the same `reservationId` to settle it.
   */
  reservationId: string;
  /** What the step might cost, in USD, as for `checkBudget()`. */
  estimatedCostUsd: string | number;
  /** The agent run; defaults to a scoped tracker's runId. */
  runId?: string;
  /** How long the hold lasts; the server's default is 600, at most 86400. */
  ttlSeconds?: number;
}

export interface RecordResult {
  /** The stored cost in USD, as an exact decimal string; null while unpriced. */
  costUsd: string | null;
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
  /**
   * Background reports from `track()` waiting to be sent, at most;
   * beyond this, new usage is dropped and reported to `onError` with code
   * "queue_full", so a slow or unreachable tracker can't grow memory
   * without bound. Defaults to 1000.
   */
  maxPending?: number;
  fetch?: typeof fetch;
}

/** How background reporting has gone since the tracker was created. */
export interface DeliveryStats {
  /** Reports the server accepted. */
  sent: number;
  /** Reports that failed after their retries; each went to `onError`. */
  failed: number;
  /** Usage not sent because too many reports were pending. */
  dropped: number;
  /** Reports still in flight. */
  pending: number;
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
   * Passes a streamed response's chunks through unchanged and reports its
   * usage in the background once the stream has finished. Iterate what it
   * returns instead of the stream. A stream that ends without its usage,
   * or is stopped early, reports nothing and calls `onError` with code
   * "no_usage" or "incomplete_stream". Stream errors reach you as usual.
   */
  trackStream<T>(
    stream: AsyncIterable<T>,
    options?: TrackOptions,
  ): AsyncIterable<T>;
  /**
   * Asks whether the project may spend `estimatedCostUsd` now, under its
   * monthly budget and, given a run ID, its run budget. A denial is a
   * result with `allowed: false`, not an error; failures throw
   * CostTrackerError, so decide whether to fail open or closed. Retried
   * after network errors, 429s and 5xx, since a check changes nothing.
   */
  checkBudget(options?: BudgetCheckOptions): Promise<BudgetCheck>;
  /**
   * Holds `estimatedCostUsd` of the budgets for a step if it fits, so
   * concurrent steps can't overspend together. Settle the hold by sending
   * the step's usage with the same `reservationId`, or release it. A
   * denial is a result with `allowed: false` and no reservation.
   * Retried after network errors, 429s and 5xx: the id makes it safe.
   */
  reserveBudget(options: ReserveOptions): Promise<BudgetReservation>;
  /** Ends a hold whose step didn't spend. Safe to repeat. */
  releaseBudget(reservationId: string): Promise<Reservation>;
  /** Waits for every background report, e.g. before a function exits. */
  flush(): Promise<void>;
  /** Counts of background reports, shared by scoped trackers. */
  stats(): DeliveryStats;
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
  created?: number;
  data?: unknown;
}

const n = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;
const details = (value: unknown): Record<string, Num> =>
  (value && typeof value === "object" ? value : {}) as Record<string, Num>;

/**
 * Audio token counts, sent only when there are any. Without a reported
 * cached split, the cached audio is the least the totals allow.
 */
function audioUsage(
  inputTokens: number,
  cachedInputTokens: number,
  audioIn: number,
  audioOut: number,
  cachedAudio?: number,
): Partial<Usage> {
  if (audioIn === 0 && audioOut === 0) return {};
  const cached = Math.min(
    cachedAudio ?? Math.max(0, audioIn - (inputTokens - cachedInputTokens)),
    audioIn,
    cachedInputTokens,
  );
  return {
    audioInputTokens: audioIn,
    ...(cached > 0 && { cachedAudioInputTokens: cached }),
    ...(audioOut > 0 && { audioOutputTokens: audioOut }),
  };
}

/**
 * OpenAI Images API (`images.generate` / `images.edit`): input split into
 * text and image tokens; the output is the generated images. The response
 * names no model, so pass one to track().
 */
export function usageFromOpenAIImage(response: AnyResponse): Usage | null {
  const usage = response.usage;
  if (!usage || typeof usage.input_tokens !== "number") return null;
  const inputTokens = n(usage.input_tokens);
  const outputTokens = n(usage.output_tokens);
  const inputDetails = details(usage.input_tokens_details);
  const cachedInputTokens = n(inputDetails.cached_tokens);
  const imageIn = n(inputDetails.image_tokens);
  const outputDetails = usage.output_tokens_details;
  // Older models report no output split: all of it is image.
  const imageOut = outputDetails
    ? n(details(outputDetails).image_tokens)
    : outputTokens;
  const cachedImage = Math.min(
    Math.max(0, imageIn - (inputTokens - cachedInputTokens)),
    imageIn,
    cachedInputTokens,
  );
  return {
    provider: "openai",
    model: response.model ?? "",
    inputTokens,
    outputTokens,
    ...(cachedInputTokens > 0 && { cachedInputTokens }),
    ...(imageIn > 0 && { imageInputTokens: imageIn }),
    ...(cachedImage > 0 && { cachedImageInputTokens: cachedImage }),
    ...(imageOut > 0 && { imageOutputTokens: imageOut }),
  };
}

/**
 * OpenAI Chat Completions: cached tokens are part of `prompt_tokens`, and
 * audio tokens (gpt-audio) are reported in the token details.
 */
export function usageFromOpenAIChat(response: AnyResponse): Usage | null {
  const usage = response.usage;
  if (!usage || typeof usage.prompt_tokens !== "number") return null;
  const inputTokens = n(usage.prompt_tokens);
  const promptDetails = details(usage.prompt_tokens_details);
  const cachedInputTokens = n(promptDetails.cached_tokens);
  return {
    provider: "openai",
    model: response.model ?? "",
    inputTokens,
    // Includes reasoning tokens, which are billed as output.
    outputTokens: n(usage.completion_tokens),
    cachedInputTokens,
    ...audioUsage(
      inputTokens,
      cachedInputTokens,
      n(promptDetails.audio_tokens),
      n(details(usage.completion_tokens_details).audio_tokens),
    ),
    requestId: response.id,
  };
}

/**
 * OpenAI Responses API: cached tokens are part of `input_tokens`. Also
 * reads a Realtime API response (from `response.done`), whose
 * `input_token_details` split audio from text, cached included.
 */
export function usageFromOpenAIResponse(response: AnyResponse): Usage | null {
  const usage = response.usage;
  if (!usage || typeof usage.input_tokens !== "number") return null;
  const inputTokens = n(usage.input_tokens);
  const realtime = usage.input_token_details;
  const inputDetails = details(usage.input_tokens_details ?? realtime);
  const cachedInputTokens = n(inputDetails.cached_tokens);
  const cachedDetails = details(
    (realtime as Record<string, unknown> | undefined)?.cached_tokens_details,
  );
  // GPT-5.6 and later charge for cache writes; 12-hour writes cost more.
  const cacheWrites = n(inputDetails.cache_write_tokens);
  const cacheWrites12h = Math.min(
    n(details(inputDetails.cache_write_tokens_details).ttl_12h_tokens),
    cacheWrites,
  );
  return {
    provider: "openai",
    model: response.model ?? "",
    inputTokens,
    outputTokens: n(usage.output_tokens),
    cachedInputTokens,
    ...(cacheWrites > 0 && {
      cacheWriteInputTokens: cacheWrites,
      cacheWrite1hInputTokens: cacheWrites12h,
    }),
    ...audioUsage(
      inputTokens,
      cachedInputTokens,
      n(inputDetails.audio_tokens),
      n(details(usage.output_token_details).audio_tokens),
      realtime ? n(cachedDetails.audio_tokens) : undefined,
    ),
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
  // A Realtime `response.done` event's response; it names no model, so
  // pass one to track().
  if (r.object === "response" || r.object === "realtime.response") {
    return usageFromOpenAIResponse(r);
  }
  if (r.object === "chat.completion") return usageFromOpenAIChat(r);
  // An Images API response: generated images in `data`, no object type.
  if (Array.isArray(r.data) && typeof r.created === "number") {
    return usageFromOpenAIImage(r);
  }
  return null;
}

/**
 * Collects usage from a streamed response's chunks, as they pass. Each
 * provider reports a stream's usage once it's complete:
 *
 * - OpenAI Chat Completions: a last chunk with `usage`, only when the
 *   request sets `stream_options: { include_usage: true }`.
 * - OpenAI Responses: the `response.completed` (or `.incomplete`) event.
 * - Anthropic Messages: `message_start` has the input counts and
 *   `message_delta` the final output count.
 * - Gemini: each chunk's `usageMetadata`; the last one has the totals.
 *
 * `usage(ended)` is null until the final usage has been seen, so a stream
 * cut short is never reported with partial counts.
 */
export function streamUsage() {
  let final: Usage | null = null;
  let anthropic: AnyResponse | null = null;
  let gemini: AnyResponse | null = null;
  return {
    push(chunk: unknown): void {
      if (!chunk || typeof chunk !== "object") return;
      const c = chunk as AnyResponse & {
        response?: AnyResponse;
        message?: AnyResponse;
      };
      if (c.object === "chat.completion.chunk" && c.usage) {
        final = usageFromOpenAIChat(c);
      } else if (
        (c.type === "response.completed" || c.type === "response.incomplete") &&
        c.response
      ) {
        final = usageFromOpenAIResponse(c.response);
      } else if (c.type === "message_start" && c.message) {
        anthropic = { ...c.message, usage: { ...c.message.usage } };
      } else if (c.type === "message_delta" && c.usage && anthropic) {
        // The delta's counts are cumulative; they replace the start's.
        anthropic = { ...anthropic, usage: { ...anthropic.usage, ...c.usage } };
        final = usageFromAnthropic(anthropic);
      } else if (c.usageMetadata) {
        gemini = c;
      }
    },
    /** The stream's usage, if complete; Gemini's needs the stream ended. */
    usage(ended: boolean): Usage | null {
      if (final) return final;
      return ended && gemini ? usageFromGemini(gemini) : null;
    },
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The longest wait between attempts, whatever Retry-After asks for. */
const MAX_RETRY_DELAY_MS = 30_000;

/**
 * The wait before retry `attempt` (1, 2, ...): 250 ms, then 1 s, 4 s...,
 * jittered to 50-100% so clients that failed together don't retry
 * together, and at least what a 429's Retry-After asked for.
 */
export function retryDelayMs(
  attempt: number,
  retryAfterSeconds: number | null,
  random: () => number = Math.random,
): number {
  const base = 250 * 4 ** (attempt - 1);
  const jittered = base * (0.5 + random() * 0.5);
  const asked = retryAfterSeconds !== null ? retryAfterSeconds * 1000 : 0;
  return Math.min(Math.max(jittered, asked), MAX_RETRY_DELAY_MS);
}

/** Retry-After in seconds, when it's a plain number of seconds. */
function retryAfter(response: Response): number | null {
  const value = Number(response.headers.get("retry-after"));
  return Number.isFinite(value) && value > 0 ? value : null;
}

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
  const maxPending = options.maxPending ?? 1000;
  const counts = { sent: 0, failed: 0, dropped: 0 };

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
    let waitAtLeast: number | null = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) await sleep(retryDelayMs(attempt, waitAtLeast));
      waitAtLeast = null;
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
      if (response.status === 429) waitAtLeast = retryAfter(response);
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
    const event = json.event as { costUsd?: string | null } | undefined;
    // Usage without a price is stored with a null cost, to be priced later.
    if (
      !event ||
      (typeof event.costUsd !== "string" && event.costUsd !== null)
    ) {
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

  async function reserveBudget(
    options: ReserveOptions,
    defaults: Scope,
  ): Promise<BudgetReservation> {
    const runId = options.runId ?? defaults.runId;
    const body: Record<string, unknown> = {
      reservationId: options.reservationId,
      estimatedCostUsd: options.estimatedCostUsd,
      ...(runId !== undefined && { runId }),
      ...(options.ttlSeconds !== undefined && {
        ttlSeconds: options.ttlSeconds,
      }),
    };
    // The reservation id makes a retry return the same hold.
    const json = await post("/api/budget/reserve", body, true);
    if (
      typeof json.allowed !== "boolean" ||
      !json.month ||
      !("reservation" in json)
    ) {
      throw new CostTrackerError("Unexpected response", null, null);
    }
    return json as unknown as BudgetReservation;
  }

  async function releaseBudget(reservationId: string): Promise<Reservation> {
    // Releasing twice leaves it released, so retrying is safe.
    const body: Record<string, unknown> = { reservationId };
    const json = await post("/api/budget/release", body, true);
    const reservation = json.reservation as Reservation | undefined;
    if (!reservation?.status) {
      throw new CostTrackerError("Unexpected response", null, null);
    }
    return reservation;
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
    report(usage, trackOptions, defaults);
    return response;
  }

  async function* trackStream<T>(
    stream: AsyncIterable<T>,
    trackOptions: TrackOptions,
    defaults: Scope,
  ): AsyncGenerator<T> {
    const collected = streamUsage();
    let ended = false;
    try {
      for await (const chunk of stream) {
        collected.push(chunk);
        yield chunk;
      }
      ended = true;
    } finally {
      // Runs when the stream ends, fails, or the caller stops early.
      const usage = collected.usage(ended);
      if (usage) {
        report(usage, trackOptions, defaults);
      } else {
        onError(
          ended
            ? new CostTrackerError(
                "No usage in stream (OpenAI Chat Completions need stream_options.include_usage)",
                null,
                "no_usage",
              )
            : new CostTrackerError(
                "Stream ended before its usage arrived",
                null,
                "incomplete_stream",
              ),
          null,
        );
      }
    }
  }

  /** Applies track options and sends in the background, within the bound. */
  function report(
    usage: Usage,
    trackOptions: TrackOptions,
    defaults: Scope,
  ): void {
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
    if (pending.size >= maxPending) {
      counts.dropped++;
      onError(
        new CostTrackerError(
          `${maxPending} reports already pending; usage dropped`,
          null,
          "queue_full",
        ),
        tracked,
      );
      return;
    }
    const sending = send(tracked).then(
      () => {
        counts.sent++;
      },
      (error: unknown) => {
        counts.failed++;
        onError(error, tracked);
      },
    );
    pending.add(sending);
    void sending.finally(() => pending.delete(sending));
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
      trackStream: (stream, trackOptions = {}) =>
        trackStream(stream, trackOptions, defaults),
      checkBudget: (options = {}) => checkBudget(options, defaults),
      reserveBudget: (options) => reserveBudget(options, defaults),
      releaseBudget,
      flush,
      stats: () => ({ ...counts, pending: pending.size }),
      with: ({ tags, ...attribution }) =>
        scoped({
          ...withDefaults(attribution, defaults),
          tags: mergeTags(defaults.tags, tags),
        }),
    };
  }

  return scoped({});
}
