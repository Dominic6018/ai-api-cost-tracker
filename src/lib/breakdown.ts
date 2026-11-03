import { ATTRIBUTION_FIELDS } from "./attribution";
import { toMicros } from "./budget";

export type BreakdownDimension = (typeof ATTRIBUTION_FIELDS)[number];

/** Groups shown individually; the rest are summed into one "Other" row. */
export const BREAKDOWN_LIMIT = 50;

/** Reads the `by` query parameter (customer, user, feature or run). */
export function parseBreakdownDimension(value: unknown): BreakdownDimension {
  const param = Array.isArray(value) ? value[0] : value;
  return (
    ATTRIBUTION_FIELDS.find((field) => field.param === param) ??
    ATTRIBUTION_FIELDS[0]
  );
}

/** One group's spend, as the database returns it. */
export interface BreakdownGroup {
  /** The attribution value; null for spend without one. */
  value: string | null;
  /** USD as an exact decimal string. */
  costUsd: string;
  events: number;
}

export interface BreakdownRow {
  /** Null for spend without the field; "other" for the rolled-up rest. */
  value: string | null;
  kind: "group" | "unset" | "other";
  costMicros: bigint;
  events: number;
  /** Groups summed into this row: 1, or more for "other". */
  groups: number;
  /** Share of total cost in tenths of a percent, rounded down. */
  sharePermille: number;
  /** Cost per request in micro-dollars, rounded half up. */
  averageMicros: bigint;
}

const permille = (part: bigint, total: bigint) =>
  total > 0n ? Number((part * 1000n) / total) : 0;
const average = (micros: bigint, events: number) =>
  events > 0 ? (micros * 2n + BigInt(events)) / (BigInt(events) * 2n) : 0n;

/**
 * Turns the top groups and the overall totals into rows whose costs add up
 * to the total: whatever the top groups don't cover becomes "Other".
 */
export function breakdownRows(
  top: readonly BreakdownGroup[],
  totals: { costUsd: string; events: number; groups: number },
): BreakdownRow[] {
  const totalMicros = toMicros(totals.costUsd);
  const row = (
    value: string | null,
    kind: BreakdownRow["kind"],
    costMicros: bigint,
    events: number,
    groups: number,
  ): BreakdownRow => ({
    value,
    kind,
    costMicros,
    events,
    groups,
    sharePermille: permille(costMicros, totalMicros),
    averageMicros: average(costMicros, events),
  });

  const rows = top.map((group) =>
    row(
      group.value,
      group.value === null ? "unset" : "group",
      toMicros(group.costUsd),
      group.events,
      1,
    ),
  );
  const shownMicros = rows.reduce((sum, r) => sum + r.costMicros, 0n);
  const shownEvents = rows.reduce((sum, r) => sum + r.events, 0);
  const restGroups = totals.groups - rows.length;
  if (restGroups > 0) {
    rows.push(
      row(
        null,
        "other",
        totalMicros - shownMicros,
        totals.events - shownEvents,
        restGroups,
      ),
    );
  }
  return rows;
}

/** "12.3%", "<0.1%" for a tiny non-zero share. */
export function formatShare(sharePermille: number, costMicros: bigint) {
  if (sharePermille === 0 && costMicros > 0n) return "<0.1%";
  return `${(sharePermille / 10).toFixed(1)}%`;
}
