/**
 * Google Cloud bills Gemini through its BigQuery billing export rather
 * than an API, so this reads a saved query result: one row per UTC day,
 * as `bq query --format=json` (an array) or the BigQuery console's JSON
 * download (one object per line) writes it.
 */

import { dollarsToMicros } from "./openai-costs";

export interface GoogleBilledDay {
  /** UTC day, YYYY-MM-DD. */
  day: string;
  micros: bigint;
  /** Credits applied that day, zero or negative. */
  creditsMicros: bigint;
}

/** BigQuery's JSON output has numbers as strings. */
function amount(value: unknown, name: string, row: number): bigint {
  const number =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : NaN;
  if (!Number.isFinite(number)) {
    throw new TypeError(`Row ${row}: ${name} isn't an amount`);
  }
  return dollarsToMicros(number);
}

function parseRow(value: unknown, row: number): GoogleBilledDay {
  const { day, currency, cost, credits } = (value ?? {}) as Record<
    string,
    unknown
  >;
  if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new TypeError(`Row ${row}: day must look like 2026-11-01`);
  }
  if (currency !== "USD") {
    throw new TypeError(
      `Row ${row}: currency must be USD, the currency of recorded costs`,
    );
  }
  return {
    day,
    micros: amount(cost, "cost", row),
    creditsMicros:
      credits === undefined || credits === null
        ? 0n
        : amount(credits, "credits", row),
  };
}

/** Reads a saved query result. Throws on a shape it doesn't recognise. */
export function parseGoogleBilling(text: string): GoogleBilledDay[] {
  const trimmed = text.trim();
  if (trimmed === "") return [];
  const rows: unknown[] = trimmed.startsWith("[")
    ? JSON.parse(trimmed)
    : trimmed.split(/\r?\n/).map((line) => JSON.parse(line));
  return rows.map((row, i) => parseRow(row, i + 1));
}
