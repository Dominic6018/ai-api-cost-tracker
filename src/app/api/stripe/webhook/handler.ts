import type { WebhookOutcome } from "@/db/stripe-webhooks";
import {
  parseStripeEvent,
  verifyStripeSignature,
  type InvoiceEvent,
  type StripeEvent,
} from "@/lib/stripe-webhook";

/** Largest accepted event; Stripe's are far smaller. */
export const MAX_BODY_BYTES = 256 * 1024;

export interface StripeWebhookDeps {
  /** The endpoint's signing secret; off without one. */
  secret: () => string | undefined;
  record: (
    event: StripeEvent,
    invoice: InvoiceEvent | null,
  ) => Promise<WebhookOutcome>;
  now?: () => Date;
}

const error = (status: number, code: string, message: string) =>
  Response.json(
    { error: { code, message } },
    { status, headers: { "cache-control": "no-store" } },
  );

/**
 * `POST /api/stripe/webhook`: Stripe's invoice events, verified by their
 * signature and recorded once. Answers 2xx for anything it accepts, even
 * events it ignores, so Stripe doesn't retry them; a failure to record
 * is a 500, which Stripe retries.
 */
export function createStripeWebhookHandler(deps: StripeWebhookDeps) {
  return async function handleStripeWebhook(request: Request) {
    const secret = deps.secret()?.trim();
    if (!secret) {
      return error(404, "not_configured", "Stripe webhooks aren't set up");
    }
    if (Number(request.headers.get("content-length")) > MAX_BODY_BYTES) {
      return error(413, "payload_too_large", "Request body too large");
    }
    // The signature covers the exact bytes, so verify the raw text.
    const body = await request.text();
    if (new TextEncoder().encode(body).length > MAX_BODY_BYTES) {
      return error(413, "payload_too_large", "Request body too large");
    }
    const check = verifyStripeSignature(
      body,
      request.headers.get("stripe-signature"),
      secret,
      deps.now?.() ?? new Date(),
    );
    if (!check.ok) {
      return error(400, "invalid_signature", `Signature ${check.reason}`);
    }
    const parsed = parseStripeEvent(body);
    if (!parsed.ok) {
      return error(400, "invalid_event", "Not a Stripe event");
    }
    const result = await deps.record(parsed.event, parsed.invoice);
    return Response.json(
      { received: true, ...result },
      { headers: { "cache-control": "no-store" } },
    );
  };
}
