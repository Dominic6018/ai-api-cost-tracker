import { z } from "zod";
import { providerEnum, SERVICE_TIERS } from "@/db/schema";
import { MAX_ATTRIBUTION_LENGTH } from "./attribution";
import { tagsSchema } from "./tags";

/** Largest accepted `metadata` object, measured as serialized JSON. */
export const MAX_METADATA_BYTES = 8 * 1024;

/** Allowed clock skew for `occurredAt` values slightly in the future. */
export const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

const tokenCount = z.number().int().nonnegative().max(2_147_483_647);
const attribution = z
  .string()
  .trim()
  .min(1)
  .max(MAX_ATTRIBUTION_LENGTH)
  .optional();

/**
 * Body of `POST /api/usage`. The project comes from the API key, not the
 * body, so a key can only record usage for its own project.
 */
export const usagePayloadSchema = z
  .object({
    provider: z.enum(providerEnum.enumValues),
    model: z.string().trim().min(1).max(200),
    inputTokens: tokenCount,
    outputTokens: tokenCount,
    cachedInputTokens: tokenCount.default(0),
    // Anthropic reports these as cache_creation_input_tokens. Like cached
    // tokens, they're part of inputTokens.
    cacheWriteInputTokens: tokenCount.default(0),
    // The part of cacheWriteInputTokens written with the longer cache
    // lifetime, billed at a higher rate: Anthropic's 1-hour writes
    // (usage.cache_creation.ephemeral_1h_input_tokens) or OpenAI's 12-hour
    // writes (input_tokens_details.cache_write_tokens_details.ttl_12h_tokens).
    cacheWrite1hInputTokens: tokenCount.default(0),
    // Web searches the request ran (Anthropic: usage.server_tool_use
    // .web_search_requests), charged per search on top of tokens.
    webSearchRequests: tokenCount.default(0),
    // Audio tokens, billed at the model's audio rates (OpenAI: usage
    // .prompt_tokens_details.audio_tokens and completion_tokens_details
    // .audio_tokens). Each is part of inputTokens, cachedInputTokens and
    // outputTokens respectively.
    audioInputTokens: tokenCount.default(0),
    cachedAudioInputTokens: tokenCount.default(0),
    audioOutputTokens: tokenCount.default(0),
    // Image tokens (OpenAI's Images API: usage.input_tokens_details
    // .image_tokens and the image output), billed at the model's image rates
    // or, without them, as text. Parts of the same totals, alongside audio.
    imageInputTokens: tokenCount.default(0),
    cachedImageInputTokens: tokenCount.default(0),
    imageOutputTokens: tokenCount.default(0),
    // "batch" for a provider's discounted Batch API (Anthropic: 50%).
    serviceTier: z.enum(SERVICE_TIERS).default("standard"),
    requestId: z.string().trim().min(1).max(200).optional(),
    customerId: attribution,
    userId: attribution,
    feature: attribution,
    runId: attribution,
    tags: tagsSchema.optional(),
    occurredAt: z.iso.datetime({ offset: true }).optional(),
    // A hold from POST /api/budget/reserve that this usage settles.
    reservationId: attribution,
    metadata: z
      .record(z.string(), z.unknown())
      .refine(
        (value) =>
          new TextEncoder().encode(JSON.stringify(value)).length <=
          MAX_METADATA_BYTES,
        `metadata must be at most ${MAX_METADATA_BYTES} bytes as JSON`,
      )
      .optional(),
  })
  .strict()
  .refine((usage) => usage.cachedInputTokens <= usage.inputTokens, {
    path: ["cachedInputTokens"],
    message: "cachedInputTokens cannot exceed inputTokens",
  })
  .refine(
    (usage) =>
      usage.cachedInputTokens + usage.cacheWriteInputTokens <=
      usage.inputTokens,
    {
      path: ["cacheWriteInputTokens"],
      message:
        "cachedInputTokens plus cacheWriteInputTokens cannot exceed inputTokens",
    },
  )
  .refine(
    (usage) => usage.cacheWrite1hInputTokens <= usage.cacheWriteInputTokens,
    {
      path: ["cacheWrite1hInputTokens"],
      message:
        "cacheWrite1hInputTokens is part of cacheWriteInputTokens and cannot exceed it",
    },
  )
  .refine(
    (usage) =>
      usage.cachedAudioInputTokens <= usage.audioInputTokens &&
      usage.cachedAudioInputTokens <= usage.cachedInputTokens,
    {
      path: ["cachedAudioInputTokens"],
      message:
        "cachedAudioInputTokens is part of both audioInputTokens and cachedInputTokens and cannot exceed either",
    },
  )
  .refine(
    (usage) =>
      usage.audioInputTokens - usage.cachedAudioInputTokens <=
      usage.inputTokens - usage.cachedInputTokens - usage.cacheWriteInputTokens,
    {
      path: ["audioInputTokens"],
      message:
        "Uncached audio input tokens cannot exceed the uncached input tokens",
    },
  )
  .refine((usage) => usage.audioOutputTokens <= usage.outputTokens, {
    path: ["audioOutputTokens"],
    message: "audioOutputTokens is part of outputTokens and cannot exceed it",
  })
  .refine(
    (usage) =>
      usage.cachedImageInputTokens <= usage.imageInputTokens &&
      usage.cachedAudioInputTokens + usage.cachedImageInputTokens <=
        usage.cachedInputTokens,
    {
      path: ["cachedImageInputTokens"],
      message:
        "cachedImageInputTokens is part of imageInputTokens, and with any cached audio of cachedInputTokens, and cannot exceed either",
    },
  )
  .refine(
    (usage) =>
      usage.audioInputTokens -
        usage.cachedAudioInputTokens +
        usage.imageInputTokens -
        usage.cachedImageInputTokens <=
      usage.inputTokens - usage.cachedInputTokens - usage.cacheWriteInputTokens,
    {
      path: ["imageInputTokens"],
      message:
        "Uncached image and audio input tokens together cannot exceed the uncached input tokens",
    },
  )
  .refine(
    (usage) =>
      usage.audioOutputTokens + usage.imageOutputTokens <= usage.outputTokens,
    {
      path: ["imageOutputTokens"],
      message:
        "imageOutputTokens, with any audio output, is part of outputTokens and cannot exceed it",
    },
  );

export type UsagePayload = z.infer<typeof usagePayloadSchema>;

/** A validated request body, with `occurredAt` resolved to a date. */
export interface ParsedUsage extends Omit<UsagePayload, "occurredAt"> {
  occurredAt: Date;
}

/** A validated usage record attributed to a project, ready to price and store. */
export interface UsageInput extends ParsedUsage {
  projectId: string;
}

export type ParseUsageResult =
  | { ok: true; usage: ParsedUsage }
  | { ok: false; fieldErrors: Record<string, string[]>; formErrors: string[] };

/**
 * Validates a request body. `occurredAt` defaults to `now` and may not be
 * more than a few minutes in the future, since it selects the price.
 */
export function parseUsagePayload(
  body: unknown,
  now: Date = new Date(),
): ParseUsageResult {
  const result = usagePayloadSchema.safeParse(body);
  if (!result.success) {
    const { fieldErrors, formErrors } = z.flattenError(result.error);
    return {
      ok: false,
      fieldErrors: fieldErrors as Record<string, string[]>,
      formErrors,
    };
  }

  const occurredAt = result.data.occurredAt
    ? new Date(result.data.occurredAt)
    : now;
  if (occurredAt.getTime() > now.getTime() + MAX_FUTURE_SKEW_MS) {
    return {
      ok: false,
      fieldErrors: { occurredAt: ["occurredAt cannot be in the future"] },
      formErrors: [],
    };
  }

  return { ok: true, usage: { ...result.data, occurredAt } };
}
