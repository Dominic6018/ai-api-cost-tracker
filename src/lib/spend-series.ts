const DAY_MS = 24 * 60 * 60 * 1000;

export const SPEND_RANGES = [7, 30, 90] as const;
export type SpendRange = (typeof SPEND_RANGES)[number];
export const DEFAULT_SPEND_RANGE: SpendRange = 30;

/** Reads the `range` query parameter, falling back to 30 days. */
export function parseSpendRange(value: unknown): SpendRange {
  const days = Number(Array.isArray(value) ? value[0] : value);
  return (SPEND_RANGES as readonly number[]).includes(days)
    ? (days as SpendRange)
    : DEFAULT_SPEND_RANGE;
}

const dayKey = (date: Date) => date.toISOString().slice(0, 10);

/**
 * The UTC days a range covers, ending with today. A 7-day range is today
 * plus the six days before it, starting at midnight UTC.
 */
export function dailyRange(now: Date, days: number) {
  const today = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  const start = new Date(today - (days - 1) * DAY_MS);
  const dayKeys = Array.from({ length: days }, (_, i) =>
    dayKey(new Date(start.getTime() + i * DAY_MS)),
  );
  return { start, dayKeys };
}

export interface DailySpend {
  /** `YYYY-MM-DD` in UTC. */
  day: string;
  /** USD as a decimal string. */
  costUsd: string;
}

/** One entry per day in `dayKeys`, with zero for days that had no usage. */
export function fillDailySeries(
  dayKeys: readonly string[],
  rows: readonly DailySpend[],
): DailySpend[] {
  const byDay = new Map(rows.map((row) => [row.day, row.costUsd]));
  return dayKeys.map((day) => ({
    day,
    costUsd: byDay.get(day) ?? "0.000000",
  }));
}

/**
 * Evenly spaced axis ticks from zero, using steps of 1, 2 or 5 times a
 * power of ten, with the top tick at or above `max`.
 */
export function niceTicks(max: number, target = 4): number[] {
  if (!(max > 0)) return [0];
  const rough = max / target;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step =
    [1, 2, 5, 10].map((m) => m * magnitude).find((s) => s >= rough) ??
    10 * magnitude;
  const count = Math.ceil(max / step - 1e-9);
  // Round away floating-point noise such as 0.30000000000000004.
  return Array.from({ length: count + 1 }, (_, i) =>
    Number((i * step).toPrecision(12)),
  );
}
