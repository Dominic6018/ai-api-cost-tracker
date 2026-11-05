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
