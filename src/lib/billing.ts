/**
 * Validation for the billing ledger: what customers are billed, kept apart
 * from what the providers charge. Amounts are exact micro-dollars.
 */

import type { AuditEntry } from "./audit";
import { MAX_ATTRIBUTION_LENGTH } from "./attribution";
import { microsToDecimal } from "./budget";
import type { BillingEntryKind } from "@/db/schema";

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
  kind: BillingEntryKind;
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

/**
 * A non-negative USD amount such as a plan's fee, in micro-dollars: up to
 * six decimals, zero allowed.
 */
export function parsePlanAmount(text: string, label: string): Parsed<bigint> {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(text.trim());
  if (!match) {
    return {
      ok: false,
      error: `${label} isn't a USD amount with up to 6 decimals: "${text}"`,
    };
  }
  const [, whole, fraction = ""] = match;
  const micros = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  if (micros > MAX_ENTRY_MICROS) {
    return { ok: false, error: `${label} is over $99,999,999.999999.` };
  }
  return { ok: true, value: micros };
}

/**
 * How usage is charged, as a multiple of its AI API cost: "1.25" charges
 * cost plus 25%, "1" at cost, "0" not at all. Up to four decimals, kept
 * as the exact decimal string the database stores.
 */
export function parseUsageMultiplier(text: string): Parsed<string> {
  const match = /^(\d{1,6})(?:\.(\d{1,4}))?$/.exec(text.trim());
  if (!match) {
    return {
      ok: false,
      error: `The usage multiplier is a number up to 999999.9999 with up to 4 decimals: "${text}"`,
    };
  }
  const [, whole, fraction = ""] = match;
  return { ok: true, value: `${BigInt(whole)}.${fraction.padEnd(4, "0")}` };
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function parsePlanSlug(value: string): Parsed<string> {
  const slug = value.trim();
  if (!SLUG.test(slug) || slug.length > 64) {
    return {
      ok: false,
      error: `A plan slug is lowercase letters and digits joined by "-", up to 64 characters: "${value}"`,
    };
  }
  return { ok: true, value: slug };
}

export const parsePlanName = (value: string) =>
  text(value, "The plan name", MAX_CUSTOMER_NAME_LENGTH);

/** A billing month, "2026-12", as the date it starts: "2026-12-01". */
export function parseBillingMonth(value: string): Parsed<string> {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(value.trim());
  if (!match) {
    return { ok: false, error: `A month is written YYYY-MM: "${value}"` };
  }
  return { ok: true, value: `${match[1]}-${match[2]}-01` };
}

/** The first day of the UTC month `now` is in, e.g. "2026-11-01". */
export function monthStart(now: Date): string {
  return `${now.toISOString().slice(0, 7)}-01`;
}

/** "2026-12-01" as "2026-12". */
export const monthLabel = (startsOn: string) => startsOn.slice(0, 7);

export function planCreatedEntry(plan: {
  slug: string;
  name: string;
  monthlyFeeUsd: string;
  includedUsageUsd: string;
  usageMultiplier: string;
  monthlyUsageLimitUsd: string | null;
  organizationId: string;
}): AuditEntry {
  return {
    action: "billing.plan_created",
    target: plan.slug,
    details: {
      name: plan.name,
      monthlyFeeUsd: plan.monthlyFeeUsd,
      includedUsageUsd: plan.includedUsageUsd,
      usageMultiplier: plan.usageMultiplier,
      monthlyUsageLimitUsd: plan.monthlyUsageLimitUsd,
    },
    organizationId: plan.organizationId,
  };
}

/** A plan change: subscribing (with a plan) or unsubscribing (without). */
export function subscriptionEntry(change: {
  customerExternalId: string;
  planSlug: string | null;
  from: string;
  /** Scheduled subscriptions this one replaced, from `from` on. */
  replaced: number;
  organizationId: string;
}): AuditEntry {
  return {
    action: change.planSlug ? "billing.subscribed" : "billing.unsubscribed",
    target: change.customerExternalId,
    details: {
      ...(change.planSlug && { plan: change.planSlug }),
      from: monthLabel(change.from),
      replaced: change.replaced,
    },
    organizationId: change.organizationId,
  };
}

/** The first day of the month after the one starting `startsOn`. */
export function nextMonth(startsOn: string): string {
  const [year, month] = startsOn.split("-").map(Number);
  return month === 12
    ? `${year + 1}-01-01`
    : `${year}-${String(month + 1).padStart(2, "0")}-01`;
}

/** A stored multiplier ("1.2500") in ten-thousandths (12500n). */
function multiplierParts(multiplier: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,4}))?$/.exec(multiplier);
  if (!match) throw new TypeError(`Not a stored multiplier: "${multiplier}"`);
  return BigInt(match[1]) * 10_000n + BigInt((match[2] ?? "").padEnd(4, "0"));
}

export interface MonthlyCharges {
  feeMicros: bigint;
  /** The month's usage at the plan's rate: cost times the multiplier. */
  usageChargeMicros: bigint;
  includedMicros: bigint;
  /** What's charged for usage: the usage charge beyond the allowance. */
  billableUsageMicros: bigint;
}

/**
 * A month's charges on a plan, from the AI API cost of the customer's
 * usage. Exact: the usage charge is rounded half up to the micro-dollar
 * once, and nothing else is rounded.
 */
export function monthlyCharges(
  plan: {
    monthlyFeeUsd: string;
    includedUsageUsd: string;
    usageMultiplier: string;
  },
  costMicros: bigint,
): MonthlyCharges {
  if (costMicros < 0n) throw new RangeError("A cost can't be negative.");
  const usageChargeMicros =
    (costMicros * multiplierParts(plan.usageMultiplier) + 5_000n) / 10_000n;
  const includedMicros = parseSignedDecimal(plan.includedUsageUsd);
  const beyond = usageChargeMicros - includedMicros;
  return {
    feeMicros: parseSignedDecimal(plan.monthlyFeeUsd),
    usageChargeMicros,
    includedMicros,
    billableUsageMicros: beyond > 0n ? beyond : 0n,
  };
}

export function chargedEntry(charge: {
  customerExternalId: string;
  period: string;
  planSlug: string;
  feeUsd: string | null;
  usageUsd: string | null;
  usageCostUsd: string;
  organizationId: string;
}): AuditEntry {
  return {
    action: "billing.charged",
    target: charge.customerExternalId,
    details: {
      month: monthLabel(charge.period),
      plan: charge.planSlug,
      feeUsd: charge.feeUsd,
      usageUsd: charge.usageUsd,
      usageCostUsd: charge.usageCostUsd,
    },
    organizationId: charge.organizationId,
  };
}

/**
 * The last day credit can be used, "2027-01-31", as the moment it
 * expires: the start of the next UTC day.
 */
export function parseCreditExpiry(value: string): Parsed<Date> {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  const day = match ? new Date(`${match[0]}T00:00:00Z`) : null;
  if (
    !day ||
    Number.isNaN(day.getTime()) ||
    day.toISOString().slice(0, 10) !== match![0]
  ) {
    return {
      ok: false,
      error: `An expiry date is written YYYY-MM-DD: "${value}"`,
    };
  }
  return { ok: true, value: new Date(day.getTime() + 86_400_000) };
}

export interface GrantBalance {
  id: string;
  remainingMicros: bigint;
  expiresAt: Date | null;
  createdAt: Date;
}

/**
 * How much of each grant to use for `owedMicros`: credit that expires
 * soonest first, then the oldest, so as little as possible goes unused.
 * Grants with nothing left, or expired at `now`, are skipped.
 */
export function allocateCredit(
  grants: GrantBalance[],
  owedMicros: bigint,
  now: Date,
): Array<{ id: string; amountMicros: bigint }> {
  const usable = grants
    .filter(
      (g) =>
        g.remainingMicros > 0n &&
        (g.expiresAt === null || g.expiresAt.getTime() > now.getTime()),
    )
    .sort(
      (a, b) =>
        (a.expiresAt?.getTime() ?? Infinity) -
          (b.expiresAt?.getTime() ?? Infinity) ||
        a.createdAt.getTime() - b.createdAt.getTime() ||
        a.id.localeCompare(b.id),
    );
  const uses: Array<{ id: string; amountMicros: bigint }> = [];
  let left = owedMicros;
  for (const grant of usable) {
    if (left <= 0n) break;
    const take = grant.remainingMicros < left ? grant.remainingMicros : left;
    uses.push({ id: grant.id, amountMicros: take });
    left -= take;
  }
  return uses;
}

export function creditGrantedEntry(grant: {
  id: string;
  customerExternalId: string;
  amountUsd: string;
  expiresAt: Date | null;
  description: string;
  organizationId: string;
}): AuditEntry {
  return {
    action: "billing.credit_granted",
    target: grant.customerExternalId,
    details: {
      grantId: grant.id,
      amountUsd: grant.amountUsd,
      expiresAt: grant.expiresAt?.toISOString() ?? null,
      description: grant.description,
    },
    organizationId: grant.organizationId,
  };
}
