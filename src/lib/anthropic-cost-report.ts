import { parseAnthropicCostReport, type BilledCost } from "./reconcile";

const ENDPOINT = "https://api.anthropic.com/v1/organizations/cost_report";
/** The API version the cost report's documentation uses. */
const ANTHROPIC_VERSION = "2023-06-01";
/** Daily buckets per page; the API allows up to 31. */
const PAGE_BUCKETS = 31;
const MAX_PAGES = 50;

export class CostReportError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "CostReportError";
    this.status = status;
  }
}

/**
 * Fetches Anthropic's billed costs for `[from, to)` from the Admin API cost
 * report, grouped by description (which names the model and cost type),
 * following pagination. Needs an Admin API key (`sk-ant-admin...`).
 */
export async function fetchAnthropicCostReport({
  adminKey,
  from,
  to,
  fetch: fetchImpl = globalThis.fetch,
}: {
  adminKey: string;
  from: Date;
  to: Date;
  fetch?: typeof fetch;
}): Promise<BilledCost[]> {
  const costs: BilledCost[] = [];
  let page: string | null = null;
  for (let i = 0; i < MAX_PAGES; i++) {
    const url = new URL(ENDPOINT);
    url.searchParams.set("starting_at", from.toISOString());
    url.searchParams.set("ending_at", to.toISOString());
    url.searchParams.set("bucket_width", "1d");
    url.searchParams.append("group_by[]", "description");
    url.searchParams.set("limit", String(PAGE_BUCKETS));
    if (page) url.searchParams.set("page", page);

    const response = await fetchImpl(url, {
      headers: {
        "x-api-key": adminKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "user-agent": "ai-api-cost-tracker (reconcile)",
      },
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const message =
        (body as { error?: { message?: string } } | null)?.error?.message ??
        `HTTP ${response.status}`;
      throw new CostReportError(
        response.status === 401 || response.status === 403
          ? `${message} (an Admin API key, sk-ant-admin..., is required)`
          : message,
        response.status,
      );
    }
    const parsed = parseAnthropicCostReport(body);
    costs.push(...parsed.costs);
    if (!parsed.nextPage) return costs;
    page = parsed.nextPage;
  }
  throw new CostReportError(`Stopped after ${MAX_PAGES} pages`);
}
