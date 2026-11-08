import { toMicros } from "./budget";

/** Token counts for a single request. */
export interface TokenUsage {
  /** All input tokens, including cached and cache-write tokens. */
  inputTokens: number;
  outputTokens: number;
  /** Portion of inputTokens read from the provider's prompt cache. */
  cachedInputTokens?: number;
  /** Portion of inputTokens written to the provider's prompt cache. */
  cacheWriteInputTokens?: number;
  /**
   * Portion of cacheWriteInputTokens written with the longer cache
   * lifetime: Anthropic's 1-hour writes (2× input, against 1.25× for
   * 5-minute writes) or OpenAI's 12-hour writes (2.5×, against 1.25× for
   * 30-minute writes).
   */
  cacheWrite1hInputTokens?: number;
  /** Portion of inputTokens that is audio, cached or not. */
  audioInputTokens?: number;
  /** Portion of audioInputTokens (and of cachedInputTokens) read from cache. */
  cachedAudioInputTokens?: number;
  /** Portion of outputTokens that is audio. */
  audioOutputTokens?: number;
  /** Portion of inputTokens that is image, cached or not. */
  imageInputTokens?: number;
  /** Portion of imageInputTokens (and of cachedInputTokens) read from cache. */
  cachedImageInputTokens?: number;
  /** Portion of outputTokens that is image. */
  imageOutputTokens?: number;
  /**
   * Defaults to standard. "batch" applies the batch multiplier; "flex" and
   * "fast" are priced from their own rows, so pass their pricing.
   */
  serviceTier?: "standard" | "batch" | "flex" | "fast";
}

/** One set of prices in USD per 1M tokens. */
export interface TokenRates {
  inputPerMTokUsd: number;
  outputPerMTokUsd: number;
  /** Falls back to the input price when the model has no cache discount. */
  cachedInputPerMTokUsd?: number | null;
  /** Falls back to the input price when cache writes aren't charged extra. */
  cacheWritePerMTokUsd?: number | null;
  /** The longer-lived cache writes; falls back to the cache-write price. */
  cacheWrite1hPerMTokUsd?: number | null;
}

/** A model's audio token prices in USD per 1M tokens. */
export interface AudioRates {
  inputPerMTokUsd: number;
  /** Falls back to the audio input price. */
  cachedInputPerMTokUsd?: number | null;
  outputPerMTokUsd: number;
}

/**
 * A model's image token prices in USD per 1M tokens. Each falls back to
 * the matching text rate in effect (vision models bill image input as
 * text); cached image input falls back to image input when that is set.
 */
export interface ImageRates {
  inputPerMTokUsd?: number | null;
  cachedInputPerMTokUsd?: number | null;
  outputPerMTokUsd?: number | null;
}

/** A model's prices, optionally with higher rates for long prompts. */
export interface TokenPricing extends TokenRates {
  /**
   * Rates for the whole request when its input tokens exceed
   * `thresholdTokens`. Long-tier cached and cache-write rates fall back
   * to the long input rate.
   */
  longContext?: (TokenRates & { thresholdTokens: number }) | null;
  /**
   * Batch requests cost this share of the standard price, every rate and
   * tier included (Anthropic: 0.5). Null when batch isn't priced.
   */
  batchMultiplier?: number | null;
  /**
   * Audio token rates, the same for long prompts. Null when audio isn't
   * priced: audio usage then throws, which callers check first.
   */
  audio?: AudioRates | null;
  /** Image token rates, the same for long prompts; null bills them as text. */
  image?: ImageRates | null;
}

/** Whether a request has any audio tokens. */
export function hasAudio(usage: TokenUsage): boolean {
  return (
    (usage.audioInputTokens ?? 0) > 0 || (usage.audioOutputTokens ?? 0) > 0
  );
}

const TOKENS_PER_MILLION = 1_000_000;
const USD_DECIMALS = 6;

function assertCount(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(
      `${name} must be a non-negative integer, got ${value}`,
    );
  }
}

function assertPrice(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative number, got ${value}`);
  }
}

/**
 * The rates that apply to a request. A prompt longer than the model's
 * threshold pays the long rates for every token, as providers bill it;
 * "longer" means strictly more input tokens than the threshold.
 */
export function ratesForUsage(
  usage: Pick<TokenUsage, "inputTokens">,
  pricing: TokenPricing,
): TokenRates {
  const long = pricing.longContext;
  if (long && usage.inputTokens > long.thresholdTokens) return long;
  return pricing;
}

/**
 * Computes the USD cost of a request, rounded to 6 decimal places to match
 * the `cost_usd` column precision. Cached and cache-write input tokens are
 * billed at their own rates and not double-counted at the input rate, and
 * so are audio and image tokens, at the model's audio and image rates.
 * Batch usage costs the standard price times the model's batch multiplier;
 * it throws when the model has none, which callers check first.
 */
export function calculateCostUsd(
  usage: TokenUsage,
  pricing: TokenPricing,
): number {
  const cached = usage.cachedInputTokens ?? 0;
  const writes = usage.cacheWriteInputTokens ?? 0;
  const writes1h = usage.cacheWrite1hInputTokens ?? 0;
  const audioIn = usage.audioInputTokens ?? 0;
  const cachedAudio = usage.cachedAudioInputTokens ?? 0;
  const audioOut = usage.audioOutputTokens ?? 0;
  const imageIn = usage.imageInputTokens ?? 0;
  const cachedImage = usage.cachedImageInputTokens ?? 0;
  const imageOut = usage.imageOutputTokens ?? 0;
  assertCount("inputTokens", usage.inputTokens);
  assertCount("outputTokens", usage.outputTokens);
  assertCount("cachedInputTokens", cached);
  assertCount("cacheWriteInputTokens", writes);
  assertCount("cacheWrite1hInputTokens", writes1h);
  assertCount("audioInputTokens", audioIn);
  assertCount("cachedAudioInputTokens", cachedAudio);
  assertCount("audioOutputTokens", audioOut);
  assertCount("imageInputTokens", imageIn);
  assertCount("cachedImageInputTokens", cachedImage);
  assertCount("imageOutputTokens", imageOut);
  if (cached + writes > usage.inputTokens) {
    throw new RangeError(
      `cachedInputTokens (${cached}) plus cacheWriteInputTokens (${writes}) cannot exceed inputTokens (${usage.inputTokens})`,
    );
  }
  if (writes1h > writes) {
    throw new RangeError(
      `cacheWrite1hInputTokens (${writes1h}) cannot exceed cacheWriteInputTokens (${writes})`,
    );
  }
  if (cachedAudio > audioIn || cachedImage > imageIn) {
    throw new RangeError(
      `cached audio (${cachedAudio}) and image (${cachedImage}) input cannot exceed their audio (${audioIn}) and image (${imageIn}) input`,
    );
  }
  if (cachedAudio + cachedImage > cached) {
    throw new RangeError(
      `cached audio and image input (${cachedAudio + cachedImage}) cannot exceed cachedInputTokens (${cached})`,
    );
  }
  const uncachedAudio = audioIn - cachedAudio;
  const uncachedImage = imageIn - cachedImage;
  if (uncachedAudio + uncachedImage > usage.inputTokens - cached - writes) {
    throw new RangeError(
      `uncached audio and image input (${uncachedAudio + uncachedImage}) cannot exceed uncached input (${usage.inputTokens - cached - writes})`,
    );
  }
  if (audioOut + imageOut > usage.outputTokens) {
    throw new RangeError(
      `audio and image output (${audioOut + imageOut}) cannot exceed outputTokens (${usage.outputTokens})`,
    );
  }
  const audio = pricing.audio;
  if ((audioIn > 0 || audioOut > 0) && !audio) {
    throw new RangeError("No audio price is configured for this model");
  }
  if (pricing.longContext) {
    assertCount(
      "longContext.thresholdTokens",
      pricing.longContext.thresholdTokens,
    );
  }

  const rates = ratesForUsage(usage, pricing);
  const inputRate = rates.inputPerMTokUsd;
  const cachedRate = rates.cachedInputPerMTokUsd ?? inputRate;
  const writeRate = rates.cacheWritePerMTokUsd ?? inputRate;
  const write1hRate = rates.cacheWrite1hPerMTokUsd ?? writeRate;
  assertPrice("inputPerMTokUsd", inputRate);
  assertPrice("outputPerMTokUsd", rates.outputPerMTokUsd);
  assertPrice("cachedInputPerMTokUsd", cachedRate);
  assertPrice("cacheWritePerMTokUsd", writeRate);
  assertPrice("cacheWrite1hPerMTokUsd", write1hRate);

  // Audio and image tokens are part of the input, cached and output
  // totals, and billed at their own rates instead of the text ones.
  let audioCost = 0;
  if (audio) {
    const audioCachedRate =
      audio.cachedInputPerMTokUsd ?? audio.inputPerMTokUsd;
    assertPrice("audio.inputPerMTokUsd", audio.inputPerMTokUsd);
    assertPrice("audio.cachedInputPerMTokUsd", audioCachedRate);
    assertPrice("audio.outputPerMTokUsd", audio.outputPerMTokUsd);
    audioCost =
      uncachedAudio * audio.inputPerMTokUsd +
      cachedAudio * audioCachedRate +
      audioOut * audio.outputPerMTokUsd;
  }
  const image = pricing.image;
  const imageInRate = image?.inputPerMTokUsd ?? inputRate;
  const imageCachedRate =
    image?.cachedInputPerMTokUsd ?? image?.inputPerMTokUsd ?? cachedRate;
  const imageOutRate = image?.outputPerMTokUsd ?? rates.outputPerMTokUsd;
  assertPrice("image.inputPerMTokUsd", imageInRate);
  assertPrice("image.cachedInputPerMTokUsd", imageCachedRate);
  assertPrice("image.outputPerMTokUsd", imageOutRate);
  const imageCost =
    uncachedImage * imageInRate +
    cachedImage * imageCachedRate +
    imageOut * imageOutRate;

  const standard =
    ((usage.inputTokens - cached - writes - uncachedAudio - uncachedImage) *
      inputRate +
      (cached - cachedAudio - cachedImage) * cachedRate +
      (writes - writes1h) * writeRate +
      writes1h * write1hRate +
      (usage.outputTokens - audioOut - imageOut) * rates.outputPerMTokUsd +
      audioCost +
      imageCost) /
    TOKENS_PER_MILLION;

  if (usage.serviceTier !== "batch") {
    return Number(standard.toFixed(USD_DECIMALS));
  }

  // The batch discount applies to the whole request, before rounding.
  const multiplier = pricing.batchMultiplier;
  if (multiplier === null || multiplier === undefined) {
    throw new RangeError("No batch price is configured for this model");
  }
  if (!(multiplier > 0 && multiplier <= 1)) {
    throw new RangeError(
      `batchMultiplier must be in (0, 1], got ${multiplier}`,
    );
  }
  // Halving often lands exactly on half a micro-dollar, where float noise
  // (427.4999… instead of 427.5) would decide the rounding. Drop the noise,
  // then round half up, as the exact FOCUS export does.
  const micros = Number((standard * multiplier * 1e6).toFixed(6));
  return Math.round(micros) / 1e6;
}

const usdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});

/** Formats a USD amount for display, e.g. `$12.3456`. */
export function formatUsd(amount: number): string {
  return usdFormatter.format(amount);
}

/**
 * The exact cost of web searches, in micro-dollars: searches × the price
 * per 1,000 ÷ 1,000, rounded half up. Charged on top of tokens, and not
 * discounted with them (Anthropic: $10 per 1,000, so $0.01 a search).
 */
export function webSearchCostMicros(
  searches: number,
  per1kUsd: string,
): bigint {
  assertCount("webSearchRequests", searches);
  const perThousand = toMicros(per1kUsd);
  return (BigInt(searches) * perThousand + 500n) / 1000n;
}
