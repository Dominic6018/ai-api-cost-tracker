/**
 * Month-end spend forecast: this month's spend so far, plus the recent
 * daily pace for the time left in the month. Deliberately simple, so the
 * dashboard can say exactly how it's computed.
 */

import {
  budgetStatus,
  budgetUtilization,
  microsToDecimal,
  toMicros,
} from "./budget";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Full UTC days the pace is averaged over. */
export const FORECAST_PACE_DAYS = 7;

/**
 * The pace window: the last 7 full UTC days, from midnight 7 days before
 * today up to (not including) today. Today's partial day is left out, so
 * an early-morning check doesn't read as a quiet day.
 */
export function forecastPaceWindow(now: Date): { start: Date; end: Date } {
  const end = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  return {
    start: new Date(end.getTime() - FORECAST_PACE_DAYS * DAY_MS),
    end,
  };
}

/** Midnight UTC at the start of next month: where this month's forecast ends. */
export function monthEnd(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

export interface MonthForecast {
  /** Projected spend for the whole month, as an exact decimal string. */
  projectedUsd: string;
  /** The month's last day (UTC), for display: "by Nov 30". */
  lastDay: Date;
}

/**
 * Projected month-end spend: `monthSpentUsd` plus `paceUsd` (spend over
 * the last 7 full UTC days) per 7 days, for the time from `now` to the
 * end of the month. Exact in micro-dollars, rounded down.
 */
export function forecastMonth(
  monthSpentUsd: string,
  paceUsd: string,
  now: Date,
): MonthForecast {
  const end = monthEnd(now);
  const remainingMs = BigInt(Math.max(0, end.getTime() - now.getTime()));
  const paceWindowMs = BigInt(FORECAST_PACE_DAYS * DAY_MS);
  const projected =
    toMicros(monthSpentUsd) + (toMicros(paceUsd) * remainingMs) / paceWindowMs;
  return {
    projectedUsd: microsToDecimal(projected),
    lastDay: new Date(end.getTime() - DAY_MS),
  };
}

/**
 * True when a project isn't over its monthly budget yet, but its forecast
 * reaches it, by the same exact rule as the dashboard's "over".
 */
export function forecastOverBudget(
  monthSpentUsd: string,
  projectedUsd: string,
  budgetUsd: string | null,
): boolean {
  if (budgetUsd === null) return false;
  const now = budgetStatus(budgetUtilization(monthSpentUsd, budgetUsd));
  const forecast = budgetStatus(budgetUtilization(projectedUsd, budgetUsd));
  return now !== "over" && forecast === "over";
}

/**
 * Full UTC days of history a forecast needs: a whole pace window, so the
 * pace isn't averaged over days before the usage began.
 */
export const MIN_HISTORY_DAYS = FORECAST_PACE_DAYS;

export type Forecast =
  | {
      enough: true;
      /** Spend so far plus the 7-day average pace for the time left. */
      projectedUsd: string;
      /** The same at the quietest and the busiest of those 7 days. */
      lowUsd: string;
      highUsd: string;
      /** The horizon: the month's last day (UTC), and days until it ends. */
      lastDay: Date;
      daysLeft: number;
    }
  | {
      enough: false;
      /** Full UTC days of history, fewer than MIN_HISTORY_DAYS. */
      historyDays: number;
      lastDay: Date;
    };

/** Full UTC days of usage history before today, at most the pace window. */
export function historyDays(earliestUsageAt: Date | null, now: Date): number {
  if (earliestUsageAt === null) return 0;
  const { end } = forecastPaceWindow(now);
  const firstDay = Date.UTC(
    earliestUsageAt.getUTCFullYear(),
    earliestUsageAt.getUTCMonth(),
    earliestUsageAt.getUTCDate(),
  );
  const days = Math.floor((end.getTime() - firstDay) / DAY_MS);
  return Math.max(0, Math.min(MIN_HISTORY_DAYS, days));
}

/**
 * The month-end forecast with its range and horizon, or "not enough data"
 * when there are fewer than 7 full days of history to take a pace from.
 * `paceDaysUsd` are the 7 pace days' spend; the range applies the
 * quietest and the busiest of them to the time left. Exact in
 * micro-dollars, rounded down.
 */
export function forecastWithRange(
  input: {
    monthSpentUsd: string;
    paceUsd: string;
    paceDaysUsd: string[];
    earliestUsageAt: Date | null;
  },
  now: Date,
): Forecast {
  const end = monthEnd(now);
  const lastDay = new Date(end.getTime() - DAY_MS);
  const history = historyDays(input.earliestUsageAt, now);
  if (history < MIN_HISTORY_DAYS) {
    return { enough: false, historyDays: history, lastDay };
  }
  const remainingMs = BigInt(Math.max(0, end.getTime() - now.getTime()));
  const spent = toMicros(input.monthSpentUsd);
  const days = input.paceDaysUsd.map(toMicros);
  const atDaily = (daily: bigint) =>
    microsToDecimal(spent + (daily * remainingMs) / BigInt(DAY_MS));
  const min = days.reduce((a, b) => (b < a ? b : a), days[0] ?? 0n);
  const max = days.reduce((a, b) => (b > a ? b : a), days[0] ?? 0n);
  return {
    enough: true,
    projectedUsd: forecastMonth(input.monthSpentUsd, input.paceUsd, now)
      .projectedUsd,
    lowUsd: atDaily(min),
    highUsd: atDaily(max),
    lastDay,
    daysLeft: Math.round((Number(remainingMs) / DAY_MS) * 10) / 10,
  };
}
