/**
 * Validation for the billing ledger: what customers are billed, kept apart
 * from what the providers charge. Amounts are exact micro-dollars.
 */

import type { AuditEntry } from "./audit";
import { MAX_ATTRIBUTION_LENGTH } from "./attribution";
import { microsToDecimal } from "./budget";

/** The largest amount numeric(14, 6) holds: $99,999,999.999999. */
export const MAX_ENTRY_MICROS = 99_999_999_999_999n;
export const MAX_DESCRIPTION_LENGTH = 500;
export const MAX_ENTRY_KEY_LENGTH = 200;
export const MAX_CUSTOMER_NAME_LENGTH = 200;

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * A signed USD amount such as "12.50" or "-0.000001", in micro-dollars.
 * More than six decimals is an error rather than rounded, since a ledger
 * entry should be exactly what was meant. Zero is refused: it changes
 * nothing.
 */
export function parseEntryAmount(text: string): Parsed<bigint> {
  const match = /^([+-]?)(\d+)(?:\.(\d{1,6}))?$/.exec(text.trim());
  if (!match) {
    return {
      ok: false,
      error: `Not a USD amount with up to 6 decimals: "${text}"`,
    };
  }
  const [, sign, whole, fraction = ""] = match;
  const magnitude =
    BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  if (magnitude === 0n) return { ok: false, error: "The amount can't be 0." };
  if (magnitude > MAX_ENTRY_MICROS) {
    return { ok: false, error: "The amount is over $99,999,999.999999." };
  }
  return { ok: true, value: sign === "-" ? -magnitude : magnitude };
}

/**
 * A stored decimal ("12.500000", "-3", "0") in micro-dollars, for amounts
 * and sums read back from the database. Throws on anything else.
 */
export function parseSignedDecimal(value: string): bigint {
  const match = /^(-?)(\d+)(?:\.(\d{1,6}))?$/.exec(value);
  if (!match) throw new TypeError(`Not a stored USD amount: "${value}"`);
  const [, sign, whole, fraction = ""] = match;
  const magnitude =
    BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  return sign === "-" ? -magnitude : magnitude;
}

function text(value: string, label: string, max: number): Parsed<string> {
  const trimmed = value.trim();
  if (trimmed.length === 0)
    return { ok: false, error: `${label} is required.` };
  if (trimmed.length > max) {
    return { ok: false, error: `${label} is over ${max} characters.` };
  }
  return { ok: true, value: trimmed };
}

/** The customerId the customer's usage is attributed to. */
export const parseCustomerExternalId = (value: string) =>
  text(value, "The customer ID", MAX_ATTRIBUTION_LENGTH);

export const parseCustomerName = (value: string) =>
  text(value, "The customer name", MAX_CUSTOMER_NAME_LENGTH);

/** Why an entry was made; kept with it for good. */
export const parseEntryDescription = (value: string) =>
  text(value, "The reason", MAX_DESCRIPTION_LENGTH);

export const parseEntryKey = (value: string) =>
  text(value, "The entry key", MAX_ENTRY_KEY_LENGTH);

/** A ledger amount for display, e.g. "-$1.250000"; exact, never rounded. */
export function formatEntryUsd(micros: bigint): string {
  const decimal = microsToDecimal(micros);
  return decimal.startsWith("-") ? `-$${decimal.slice(1)}` : `$${decimal}`;
}

export function customerCreatedEntry(customer: {
  externalId: string;
  name: string;
  organizationId: string;
}): AuditEntry {
  return {
    action: "billing.customer_created",
    target: customer.externalId,
    details: { name: customer.name },
    organizationId: customer.organizationId,
  };
}

export function ledgerEntryAudit(entry: {
  id: string;
  kind: "adjustment" | "reversal";
  amountUsd: string;
  description: string;
  reversesEntryId: string | null;
  organizationId: string;
  customerExternalId: string;
}): AuditEntry {
  return {
    action: entry.kind === "reversal" ? "billing.reversed" : "billing.adjusted",
    target: entry.customerExternalId,
    details: {
      entryId: entry.id,
      amountUsd: entry.amountUsd,
      description: entry.description,
      ...(entry.reversesEntryId && { reversesEntryId: entry.reversesEntryId }),
    },
    organizationId: entry.organizationId,
  };
}
