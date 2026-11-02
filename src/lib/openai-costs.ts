/**
 * OpenAI's organization costs API (`GET /v1/organization/costs`), which
 * reports billed cost per day, grouped here by line item.
 */

const ENDPOINT = "https://api.openai.com/v1/organization/costs";
/** Daily buckets per page; the API allows up to 180. */
const PAGE_BUCKETS = 180;
const MAX_PAGES = 50;

/** One billed line item for a UTC day. */
export interface OpenAIBilledCost {
  /** UTC day, YYYY-MM-DD. */
  day: string;
  /** OpenAI's billing label, e.g. "Image models"; null when not grouped. */
  lineItem: string | null;
  micros: bigint;
}

export class OpenAICostsError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "OpenAICostsError";
    this.status = status;
  }
}

/**
 * Dollars as a JSON number to micro-dollars. Rounding to the nearest
 * micro-dollar is exact for any amount below about $9 billion.
 */
export function dollarsToMicros(value: number): bigint {
  if (!Number.isFinite(value)) throw new TypeError(`Not an amount: ${value}`);
  return BigInt(Math.round(value * 1_000_000));
}

interface CostsResult {
  amount?: { value?: unknown; currency?: unknown } | null;
  line_item?: unknown;
}

/** Reads one page of the costs API. Throws on a shape it doesn't recognise. */
export function parseOpenAICostsPage(page: unknown): {
  costs: OpenAIBilledCost[];
  nextPage: string | null;
} {
  const { data, has_more, next_page } = (page ?? {}) as {
    data?: unknown;
    has_more?: unknown;
    next_page?: unknown;
  };
  if (!Array.isArray(data)) {
    throw new TypeError("Not an OpenAI costs page: missing data[]");
  }
  const costs: OpenAIBilledCost[] = [];
  for (const bucket of data as { start_time?: unknown; results?: unknown }[]) {
    if (typeof bucket.start_time !== "number") {
      throw new TypeError("Costs bucket without a start_time");
    }
    const day = new Date(bucket.start_time * 1000).toISOString().slice(0, 10);
    for (const result of (Array.isArray(bucket.results)
      ? bucket.results
      : []) as CostsResult[]) {
      const value = result.amount?.value;
      if (typeof value !== "number") {
        throw new TypeError("Costs result without an amount");
      }
      const currency = result.amount?.currency;
      if (typeof currency === "string" && currency.toLowerCase() !== "usd") {
        throw new TypeError(`Unsupported currency: ${currency}`);
      }
      costs.push({
        day,
        lineItem:
          typeof result.line_item === "string" ? result.line_item : null,
        micros: dollarsToMicros(value),
      });
    }
  }
  return {
    costs,
    nextPage:
      has_more === true && typeof next_page === "string" ? next_page : null,
  };
}

/**
 * Fetches OpenAI's billed costs for `[from, to)`, grouped by line item,
 * following pagination. Needs an Admin key (`sk-admin-...`).
 */
export async function fetchOpenAICosts({
  adminKey,
  from,
  to,
  fetch: fetchImpl = globalThis.fetch,
}: {
  adminKey: string;
  from: Date;
  to: Date;
  fetch?: typeof fetch;
}): Promise<OpenAIBilledCost[]> {
  const costs: OpenAIBilledCost[] = [];
  let page: string | null = null;
  for (let i = 0; i < MAX_PAGES; i++) {
    const url = new URL(ENDPOINT);
    url.searchParams.set(
      "start_time",
      String(Math.floor(from.getTime() / 1000)),
    );
    url.searchParams.set("end_time", String(Math.floor(to.getTime() / 1000)));
    url.searchParams.set("bucket_width", "1d");
    url.searchParams.append("group_by", "line_item");
    url.searchParams.set("limit", String(PAGE_BUCKETS));
    if (page) url.searchParams.set("page", page);

    const response = await fetchImpl(url, {
      headers: {
        authorization: `Bearer ${adminKey}`,
        "user-agent": "ai-api-cost-tracker (reconcile)",
      },
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const message =
        (body as { error?: { message?: string } } | null)?.error?.message ??
        `HTTP ${response.status}`;
      throw new OpenAICostsError(
        response.status === 401 || response.status === 403
          ? `${message} (an OpenAI Admin key, sk-admin-..., is required)`
          : message,
        response.status,
      );
    }
    const parsed = parseOpenAICostsPage(body);
    costs.push(...parsed.costs);
    if (!parsed.nextPage) return costs;
    page = parsed.nextPage;
  }
  throw new OpenAICostsError(`Stopped after ${MAX_PAGES} pages`);
}
