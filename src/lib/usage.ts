import { z } from "zod";
import { providerEnum } from "@/db/schema";

/** Largest accepted `metadata` object, measured as serialized JSON. */
export const MAX_METADATA_BYTES = 8 * 1024;

/** Allowed clock skew for `occurredAt` values slightly in the future. */
export const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

const tokenCount = z.number().int().nonnegative().max(2_147_483_647);

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
    requestId: z.string().trim().min(1).max(200).optional(),
    occurredAt: z.iso.datetime({ offset: true }).optional(),
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
  });

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
