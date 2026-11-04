import { z } from "zod";
import { ATTRIBUTION_FIELDS } from "./attribution";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Longest range one spend report covers. */
export const MAX_REPORT_DAYS = 366;
export const DEFAULT_REPORT_DAYS = 30;

/** How a spend report groups usage. */
export const SPEND_GROUPS = [
  "day",
  "provider",
  "model",
  ...ATTRIBUTION_FIELDS.map((field) => field.param),
] as const;
export type SpendGroup = (typeof SPEND_GROUPS)[number];

/** Groups returned at most; `truncated` says when there were more. */
export const MAX_REPORT_GROUPS = 1000;

const day = z.iso.date();

const spendQuerySchema = z
  .object({
    from: day.optional(),
    to: day.optional(),
    groupBy: z.enum(SPEND_GROUPS).default("day"),
  })
  .strict();

export interface SpendQuery {
  /** `YYYY-MM-DD`, inclusive, UTC. */
  from: string;
  /** `YYYY-MM-DD`, inclusive, UTC. */
  to: string;
  groupBy: SpendGroup;
  /** `[start, end)` for the query. */
  start: Date;
  end: Date;
}

export type ParseSpendQueryResult =
  | { ok: true; query: SpendQuery }
  | { ok: false; fieldErrors: Record<string, string[]> };

const dayKey = (time: number) => new Date(time).toISOString().slice(0, 10);

/**
 * Reads `?from=&to=&groupBy=`. Unlike the dashboard, which drops values it
 * can't use, an API rejects them, so callers see their mistakes. Without
 * dates, the range is the last 30 UTC days, ending today.
 */
export function parseSpendQuery(
  params: URLSearchParams,
  now: Date = new Date(),
): ParseSpendQueryResult {
  const result = spendQuerySchema.safeParse(Object.fromEntries(params));
  if (!result.success) {
    return {
      ok: false,
      fieldErrors: z.flattenError(result.error).fieldErrors as Record<
        string,
        string[]
      >,
    };
  }
  const today = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  const to = result.data.to ?? dayKey(today);
  const from =
    result.data.from ??
    dayKey(Date.parse(`${to}T00:00:00Z`) - (DEFAULT_REPORT_DAYS - 1) * DAY_MS);
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(Date.parse(`${to}T00:00:00Z`) + DAY_MS);
  if (start >= end) {
    return { ok: false, fieldErrors: { from: ["from must not be after to"] } };
  }
  if ((end.getTime() - start.getTime()) / DAY_MS > MAX_REPORT_DAYS) {
    return {
      ok: false,
      fieldErrors: {
        from: [`A report covers at most ${MAX_REPORT_DAYS} days`],
      },
    };
  }
  return {
    ok: true,
    query: { from, to, groupBy: result.data.groupBy, start, end },
  };
}

/** Events per page of the usage report: default and maximum. */
export const USAGE_REPORT_LIMIT = { default: 100, max: 500 };

/** Reads `?limit=`; anything else invalid is an error, not a fallback. */
export function parseReportLimit(
  value: string | null,
): { ok: true; limit: number } | { ok: false; error: string } {
  if (value === null) return { ok: true, limit: USAGE_REPORT_LIMIT.default };
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > USAGE_REPORT_LIMIT.max) {
    return {
      ok: false,
      error: `limit must be a whole number from 1 to ${USAGE_REPORT_LIMIT.max}`,
    };
  }
  return { ok: true, limit };
}
