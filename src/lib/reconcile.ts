/**
 * Compares the costs the tracker recorded with what a provider billed, per
 * UTC day and model. Money is in micro-dollars (bigint) throughout.
 */

/** One billed amount from a provider's cost report. */
export interface BilledCost {
  /** UTC day, YYYY-MM-DD. */
  day: string;
  /** Null for costs that aren't per model, such as web search. */
  model: string | null;
  /** e.g. "tokens", "web_search", "code_execution". */
  costType: string;
  micros: bigint;
}

/** Recorded cost for one UTC day and model. */
export interface RecordedCost {
  day: string;
  model: string;
  micros: bigint;
}

/**
 * Converts a decimal string of US cents, as Anthropic's cost report gives
 * it ("123.78912" is $1.2378912), to micro-dollars, rounding half away
 * from zero at the sixth decimal of a dollar. No floating point.
 */
export function centsToMicros(amount: string): bigint {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(amount.trim());
  if (!match) throw new TypeError(`Not a cents amount: "${amount}"`);
  const [, sign, whole, fraction = ""] = match;
  // 1 cent = 10,000 micro-dollars, so four fraction digits are exact.
  let micros =
    BigInt(whole) * 10_000n + BigInt(fraction.padEnd(4, "0").slice(0, 4));
  if (Number(fraction[4] ?? "0") >= 5) micros += 1n;
  return sign ? -micros : micros;
}

interface CostReportResult {
  amount?: unknown;
  currency?: unknown;
  cost_type?: unknown;
  model?: unknown;
}
interface CostReportBucket {
  starting_at?: unknown;
  results?: unknown;
}

/**
 * Reads one page of Anthropic's `GET /v1/organizations/cost_report`,
 * requested with `group_by[]=description` so each row names its model and
 * cost type. Throws on a shape it doesn't recognise rather than guessing.
 */
export function parseAnthropicCostReport(page: unknown): {
  costs: BilledCost[];
  nextPage: string | null;
} {
  const { data, has_more, next_page } = (page ?? {}) as {
    data?: unknown;
    has_more?: unknown;
    next_page?: unknown;
  };
  if (!Array.isArray(data)) {
    throw new TypeError("Not an Anthropic cost report: missing data[]");
  }
  const costs: BilledCost[] = [];
  for (const bucket of data as CostReportBucket[]) {
    if (typeof bucket.starting_at !== "string") {
      throw new TypeError("Cost report bucket without starting_at");
    }
    const day = bucket.starting_at.slice(0, 10);
    for (const result of (Array.isArray(bucket.results)
      ? bucket.results
      : []) as CostReportResult[]) {
      if (typeof result.amount !== "string") {
        throw new TypeError("Cost report result without an amount");
      }
      if (result.currency !== undefined && result.currency !== "USD") {
        throw new TypeError(`Unsupported currency: ${String(result.currency)}`);
      }
      costs.push({
        day,
        model: typeof result.model === "string" ? result.model : null,
        costType:
          typeof result.cost_type === "string" ? result.cost_type : "unknown",
        micros: centsToMicros(result.amount),
      });
    }
  }
  return {
    costs,
    nextPage:
      has_more === true && typeof next_page === "string" ? next_page : null,
  };
}

export interface ReconcileRow {
  day: string;
  model: string;
  billedMicros: bigint;
  recordedMicros: bigint;
  /** Recorded minus billed: negative means the tracker under-counts. */
  diffMicros: bigint;
  /** Beyond the tolerance. */
  flagged: boolean;
}

export interface ReconcileReport {
  rows: ReconcileRow[];
  /** Billed costs the tracker doesn't record, such as web search. */
  otherCosts: { costType: string; micros: bigint }[];
  totals: { billedMicros: bigint; recordedMicros: bigint; diffMicros: bigint };
}

/** Never flag differences below a cent; providers bill in rounded units. */
const MIN_FLAGGED_MICROS = 10_000n;

/**
 * Lines up billed token costs with recorded costs by day and model. A row
 * is flagged when the difference exceeds `tolerancePercent` of the billed
 * amount and is at least one cent.
 */
export function reconcile(
  billed: BilledCost[],
  recorded: RecordedCost[],
  tolerancePercent = 2,
): ReconcileReport {
  const rows = new Map<string, ReconcileRow>();
  const row = (day: string, model: string) => {
    const key = `${day}\u0000${model}`;
    let existing = rows.get(key);
    if (!existing) {
      existing = {
        day,
        model,
        billedMicros: 0n,
        recordedMicros: 0n,
        diffMicros: 0n,
        flagged: false,
      };
      rows.set(key, existing);
    }
    return existing;
  };

  const other = new Map<string, bigint>();
  for (const cost of billed) {
    if (cost.costType === "tokens" && cost.model) {
      row(cost.day, cost.model).billedMicros += cost.micros;
    } else {
      other.set(cost.costType, (other.get(cost.costType) ?? 0n) + cost.micros);
    }
  }
  for (const cost of recorded) {
    row(cost.day, cost.model).recordedMicros += cost.micros;
  }

  // Tolerance in hundredths of a percent, so the check stays in integers.
  const toleranceBasisPoints = BigInt(Math.round(tolerancePercent * 100));
  const totals = { billedMicros: 0n, recordedMicros: 0n, diffMicros: 0n };
  const sorted = [...rows.values()].sort(
    (a, b) => a.day.localeCompare(b.day) || a.model.localeCompare(b.model),
  );
  for (const r of sorted) {
    r.diffMicros = r.recordedMicros - r.billedMicros;
    const abs = r.diffMicros < 0n ? -r.diffMicros : r.diffMicros;
    r.flagged =
      abs >= MIN_FLAGGED_MICROS &&
      abs * 10_000n > r.billedMicros * toleranceBasisPoints;
    totals.billedMicros += r.billedMicros;
    totals.recordedMicros += r.recordedMicros;
  }
  totals.diffMicros = totals.recordedMicros - totals.billedMicros;

  return {
    rows: sorted,
    otherCosts: [...other]
      .map(([costType, micros]) => ({ costType, micros }))
      .sort((a, b) => a.costType.localeCompare(b.costType)),
    totals,
  };
}

/** "$1.234567" or "-$0.000300", exact to the micro-dollar. */
export function formatMicros(micros: bigint): string {
  const sign = micros < 0n ? "-" : "";
  const abs = micros < 0n ? -micros : micros;
  const whole = abs / 1_000_000n;
  const fraction = (abs % 1_000_000n).toString().padStart(6, "0");
  return `${sign}$${whole}.${fraction}`;
}
