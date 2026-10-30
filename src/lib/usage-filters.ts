import { z } from "zod";
import { providerEnum, type Provider } from "@/db/schema";

const DAY_MS = 24 * 60 * 60 * 1000;
export const USAGE_PAGE_SIZE = 50;

/** Position after the last row shown: its exact `occurred_at` and id. */
export interface UsageCursor {
  /** ISO timestamp with microseconds, as Postgres stores it. */
  occurredAt: string;
  id: string;
}

export interface UsageFilters {
  projectId?: string;
  provider?: Provider;
  model?: string;
  /** `YYYY-MM-DD`, inclusive, UTC. */
  from?: string;
  /** `YYYY-MM-DD`, inclusive, UTC. */
  to?: string;
  cursor?: UsageCursor;
}

const CURSOR_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z\|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function encodeCursor({ occurredAt, id }: UsageCursor): string {
  return Buffer.from(`${occurredAt}|${id}`, "utf8").toString("base64url");
}

/** Returns undefined for anything that isn't a cursor this app produced. */
export function decodeCursor(value: string): UsageCursor | undefined {
  const decoded = Buffer.from(value, "base64url").toString("utf8");
  if (!CURSOR_PATTERN.test(decoded)) return undefined;
  const [occurredAt, id] = decoded.split("|");
  return Number.isNaN(Date.parse(occurredAt)) ? undefined : { occurredAt, id };
}

const isoDay = z.iso.date();
const first = (value: unknown) => (Array.isArray(value) ? value[0] : value);
const text = (value: unknown) =>
  typeof first(value) === "string" ? (first(value) as string).trim() : "";

/**
 * Reads filters from query parameters. Invalid values are dropped rather
 * than rejected, so a hand-edited URL still shows a page. If `from` is
 * after `to`, they are swapped.
 */
export function parseUsageFilters(
  params: Record<string, unknown>,
): UsageFilters {
  const filters: UsageFilters = {};

  const projectId = text(params.project);
  if (z.uuid().safeParse(projectId).success) filters.projectId = projectId;

  const provider = text(params.provider);
  if ((providerEnum.enumValues as readonly string[]).includes(provider)) {
    filters.provider = provider as Provider;
  }

  const model = text(params.model);
  if (model && model.length <= 200) filters.model = model;

  let from = text(params.from);
  let to = text(params.to);
  if (!isoDay.safeParse(from).success) from = "";
  if (!isoDay.safeParse(to).success) to = "";
  if (from && to && from > to) [from, to] = [to, from];
  if (from) filters.from = from;
  if (to) filters.to = to;

  const cursor = text(params.cursor);
  if (cursor) filters.cursor = decodeCursor(cursor);
  if (!filters.cursor) delete filters.cursor;

  return filters;
}

/** UTC time bounds for the date filters: `[start, end)`. */
export function dateBounds({ from, to }: Pick<UsageFilters, "from" | "to">): {
  start?: Date;
  end?: Date;
} {
  return {
    start: from ? new Date(`${from}T00:00:00Z`) : undefined,
    end: to ? new Date(Date.parse(`${to}T00:00:00Z`) + DAY_MS) : undefined,
  };
}

/** Query string for the filters, without the cursor unless given. */
export function usageQuery(
  filters: Omit<UsageFilters, "cursor">,
  cursor?: UsageCursor,
): string {
  const params = new URLSearchParams();
  if (filters.projectId) params.set("project", filters.projectId);
  if (filters.provider) params.set("provider", filters.provider);
  if (filters.model) params.set("model", filters.model);
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  if (cursor) params.set("cursor", encodeCursor(cursor));
  const query = params.toString();
  return query ? `?${query}` : "";
}
