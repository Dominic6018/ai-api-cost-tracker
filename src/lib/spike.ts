/**
 * Spending spikes: a day whose spend is far above the recent pace, such as
 * a runaway agent. Compared exactly, in micro-dollars.
 */

import { microsToDecimal, toMicros } from "./budget";
import { FORECAST_PACE_DAYS } from "./forecast";

export const SPIKE_RULES = {
  /** Today must be at least this many times the usual daily spend... */
  multiplier: 3,
  /** ...and at least this much, so small amounts aren't flagged. */
  minimumUsd: "1.00",
} as const;

export interface SpikeCheck {
  spike: boolean;
  /** The average daily spend of the last 7 full UTC days, rounded down. */
  dailyAverageUsd: string;
  /**
   * Today's spend as a multiple of that average, rounded down to one
   * decimal (e.g. 5.2); null when the average is zero.
   */
  multiple: number | null;
}

/**
 * Whether today's spend so far is a spike: at least $1 and at least 3×
 * the average daily spend of the last 7 full UTC days (`last7FullDaysUsd`,
 * the forecast's pace). A week without spend averages zero, so any day
 * of $1 or more after it counts.
 */
export function detectSpike(
  todayUsd: string,
  last7FullDaysUsd: string,
): SpikeCheck {
  const today = toMicros(todayUsd);
  const week = toMicros(last7FullDaysUsd);
  const days = BigInt(FORECAST_PACE_DAYS);
  // today ≥ multiplier × week / days, without dividing.
  const spike =
    today >= toMicros(SPIKE_RULES.minimumUsd) &&
    today * days >= BigInt(SPIKE_RULES.multiplier) * week;
  return {
    spike,
    dailyAverageUsd: microsToDecimal(week / days),
    multiple: week === 0n ? null : Number((today * days * 10n) / week) / 10,
  };
}
