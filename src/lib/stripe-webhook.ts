/**
 * Stripe webhooks: verifying a request really came from Stripe, and
 * reading the invoice events the tracker records. Stripe signs each
 * request with the endpoint's signing secret: the `Stripe-Signature`
 * header holds a timestamp `t` and one or more `v1` HMAC-SHA256
 * signatures of `${t}.${body}`.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/** How old a signed request may be, against replays. */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

export type SignatureCheck =
  | { ok: true }
  | { ok: false; reason: "missing" | "malformed" | "expired" | "mismatch" };

export function verifyStripeSignature(
  body: string,
  header: string | null,
  secret: string,
  now: Date = new Date(),
): SignatureCheck {
  if (!header) return { ok: false, reason: "missing" };
  let timestamp: string | null = null;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const [key, value] = part.split("=", 2).map((s) => s.trim());
    if (key === "t" && value) timestamp = value;
    if (key === "v1" && value) signatures.push(value);
  }
  if (!timestamp || !/^\d+$/.test(timestamp) || signatures.length === 0) {
    return { ok: false, reason: "malformed" };
  }
  const age = Math.abs(now.getTime() / 1000 - Number(timestamp));
  if (age > SIGNATURE_TOLERANCE_SECONDS) {
    return { ok: false, reason: "expired" };
  }
  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest();
  const matches = signatures.some((sig) => {
    if (!/^[0-9a-f]{64}$/i.test(sig)) return false;
    return timingSafeEqual(expected, Buffer.from(sig, "hex"));
  });
  return matches ? { ok: true } : { ok: false, reason: "mismatch" };
}

/** The statuses an invoice can move through, from its events. */
export const INVOICE_STATUSES = [
  "open",
  "paid",
  "payment_failed",
  "void",
  "uncollectible",
] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

const STATUS_BY_EVENT: Record<string, InvoiceStatus> = {
  "invoice.finalized": "open",
  "invoice.paid": "paid",
  "invoice.payment_failed": "payment_failed",
  "invoice.voided": "void",
  "invoice.marked_uncollectible": "uncollectible",
};

export interface StripeEvent {
  id: string;
  type: string;
  livemode: boolean;
  /** When Stripe created the event. */
  created: Date;
}

export interface InvoiceEvent extends StripeEvent {
  status: InvoiceStatus;
  stripeInvoiceId: string;
  /** Cents paid, for `invoice.paid`; null otherwise. */
  amountPaidCents: bigint | null;
  currency: string | null;
}

export type ParsedEvent =
  | { ok: true; event: StripeEvent; invoice: InvoiceEvent | null }
  | { ok: false };

/**
 * Reads an event's envelope, and its invoice when it's one of the
 * invoice events the tracker records; other events parse with a null
 * invoice, to be acknowledged and ignored.
 */
export function parseStripeEvent(body: string): ParsedEvent {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return { ok: false };
  }
  const e = json as {
    id?: unknown;
    type?: unknown;
    livemode?: unknown;
    created?: unknown;
    data?: { object?: Record<string, unknown> };
  };
  if (
    typeof e.id !== "string" ||
    typeof e.type !== "string" ||
    typeof e.livemode !== "boolean" ||
    typeof e.created !== "number"
  ) {
    return { ok: false };
  }
  const event: StripeEvent = {
    id: e.id,
    type: e.type,
    livemode: e.livemode,
    created: new Date(e.created * 1000),
  };
  const status = STATUS_BY_EVENT[e.type];
  const object = e.data?.object;
  if (!status || typeof object?.id !== "string") {
    return { ok: true, event, invoice: null };
  }
  const paid = object.amount_paid;
  return {
    ok: true,
    event,
    invoice: {
      ...event,
      status,
      stripeInvoiceId: object.id,
      amountPaidCents:
        status === "paid" &&
        typeof paid === "number" &&
        Number.isSafeInteger(paid)
          ? BigInt(paid)
          : null,
      currency: typeof object.currency === "string" ? object.currency : null,
    },
  };
}
