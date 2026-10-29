const DAY_MS = 24 * 60 * 60 * 1000;

export type SpendWindow = "today" | "month" | "last30Days";

export interface SpendWindows {
  /** Midnight UTC at the start of the current day. */
  today: Date;
  /** Midnight UTC on the first day of the current calendar month. */
  month: Date;
  /** Exactly 30 × 24 hours before `now` (a rolling window). */
  last30Days: Date;
}

/**
 * Start of each spend window. All windows use UTC and run up to `now`;
 * usage is counted when its `occurredAt` is at or after the start.
 */
export function spendWindows(now: Date): SpendWindows {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  return {
    today: new Date(Date.UTC(year, month, now.getUTCDate())),
    month: new Date(Date.UTC(year, month, 1)),
    last30Days: new Date(now.getTime() - 30 * DAY_MS),
  };
}

/** The earliest window start, which bounds the rows a query has to read. */
export function earliestWindowStart(windows: SpendWindows): Date {
  return new Date(
    Math.min(
      windows.today.getTime(),
      windows.month.getTime(),
      windows.last30Days.getTime(),
    ),
  );
}
