/**
 * The read-only customer portal: what one billing customer sees of their
 * own account. It shows what they're billed, never what their AI usage
 * cost the organization, which would reveal its margin.
 */

import type { BillingEntryKind } from "@/db/schema";
import { absoluteUrl } from "./links";

/** How long a portal link works; make a new one after. */
export const PORTAL_LINK_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export const portalPath = (token: string) => `/portal/${token}`;

export const portalUrl = (
  token: string,
  request: { host: string | null; proto: string | null },
) => absoluteUrl(portalPath(token), request);

/** How the customer's statement names each kind of entry. */
export const ENTRY_KIND_LABELS: Record<BillingEntryKind, string> = {
  adjustment: "Adjustment",
  reversal: "Correction",
  plan_fee: "Plan fee",
  usage_charge: "Usage",
  credit_applied: "Credit applied",
  payment: "Payment",
};

/**
 * An entry's description as the customer reads it. A usage charge's own
 * description is written for staff and spells out the AI API cost and the
 * multiplier, so the statement names just its month instead. Everything
 * else is shown as written.
 */
export function statementDescription(entry: {
  kind: BillingEntryKind;
  description: string;
  period: string | null;
}): string {
  if (entry.kind !== "usage_charge") return entry.description;
  return entry.period ? `Usage, ${entry.period.slice(0, 7)}` : "Usage";
}

/** One message for every unusable link. */
export const INVALID_PORTAL_MESSAGE =
  "This link can't be used. It may have expired or been revoked. Ask your provider for a new one.";

/** What the page says about a balance, in words a customer reads. */
export function describeBalance(balanceMicros: bigint): {
  label: string;
  micros: bigint;
} {
  if (balanceMicros > 0n) return { label: "You owe", micros: balanceMicros };
  if (balanceMicros < 0n) {
    return { label: "In credit", micros: -balanceMicros };
  }
  return { label: "Nothing owed", micros: 0n };
}

/**
 * A ledger amount for a customer to read: cents when it's whole cents,
 * otherwise every digit kept, so lines still add up to the balance.
 */
export function formatStatementUsd(micros: bigint): string {
  const negative = micros < 0n;
  const abs = negative ? -micros : micros;
  const dollars = abs / 1_000_000n;
  const fraction = (abs % 1_000_000n).toString().padStart(6, "0");
  const decimals = fraction.endsWith("0000")
    ? fraction.slice(0, 2)
    : fraction.replace(/0+$/, "");
  const grouped = dollars.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}$${grouped}.${decimals}`;
}
