import { z } from "zod";
import { MAX_ATTRIBUTION_LENGTH } from "./attribution";
import { MAX_FUTURE_SKEW_MS } from "./usage";

/** Largest count one record can carry, e.g. a nightly batch of tickets. */
export const MAX_OUTCOME_COUNT = 1_000_000;

const attribution = z
  .string()
  .trim()
  .min(1)
  .max(MAX_ATTRIBUTION_LENGTH)
  .optional();

/**
 * Body of `POST /api/outcomes`. Like usage, the project comes from the API
 * key, and attribution uses the same fields so the two can be matched.
 */
export const outcomePayloadSchema = z
  .object({
    // Lowercase words joined by _ . or -, e.g. "ticket_resolved".
    name: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(
        /^[a-z0-9]+([_.-][a-z0-9]+)*$/,
        "Use lowercase letters, digits and _ . - (e.g. ticket_resolved)",
      ),
    count: z.number().int().min(1).max(MAX_OUTCOME_COUNT).default(1),
    outcomeId: z.string().trim().min(1).max(200).optional(),
    occurredAt: z.iso.datetime({ offset: true }).optional(),
    customerId: attribution,
    userId: attribution,
    feature: attribution,
    runId: attribution,
  })
  .strict();

export type OutcomePayload = z.infer<typeof outcomePayloadSchema>;

export interface OutcomeInput extends Omit<OutcomePayload, "occurredAt"> {
  projectId: string;
  occurredAt: Date;
}

export type ParseOutcomeResult =
  | { ok: true; outcome: Omit<OutcomeInput, "projectId"> }
  | { ok: false; fieldErrors: Record<string, string[]>; formErrors: string[] };

/** Validates a request body; `occurredAt` defaults to `now`. */
export function parseOutcomePayload(
  body: unknown,
  now: Date = new Date(),
): ParseOutcomeResult {
  const result = outcomePayloadSchema.safeParse(body);
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
  return { ok: true, outcome: { ...result.data, occurredAt } };
}
