import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createStripeWebhookHandler } from "./handler";

const SECRET = ["whsec", "handler", "tests"].join("_");
const NOW = new Date("2026-11-21T12:00:00Z");
const T = Math.floor(NOW.getTime() / 1000);

const body = JSON.stringify({
  id: "evt_1",
  type: "invoice.paid",
  livemode: true,
  created: T,
  data: { object: { id: "in_1", amount_paid: 1000, currency: "usd" } },
});

const signed = (text: string, secret = SECRET) =>
  new Request("https://costs.example.com/api/stripe/webhook", {
    method: "POST",
    headers: {
      "stripe-signature": `t=${T},v1=${createHmac("sha256", secret).update(`${T}.${text}`).digest("hex")}`,
    },
    body: text,
  });

// null means no secret: undefined would take the default.
function setup(secret: string | null = SECRET) {
  const record = vi
    .fn()
    .mockResolvedValue({ outcome: "recorded", paymentPosted: true });
  const handler = createStripeWebhookHandler({
    secret: () => secret ?? undefined,
    record,
    now: () => NOW,
  });
  return { handler, record };
}

describe("POST /api/stripe/webhook", () => {
  it("records a signed event and acknowledges it", async () => {
    const { handler, record } = setup();
    const response = await handler(signed(body));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      received: true,
      outcome: "recorded",
      paymentPosted: true,
    });
    const [event, invoice] = record.mock.calls[0];
    expect(event).toMatchObject({ id: "evt_1", livemode: true });
    expect(invoice).toMatchObject({
      stripeInvoiceId: "in_1",
      amountPaidCents: 1000n,
    });
  });

  it("is off without a signing secret", async () => {
    const { handler, record } = setup(null);
    const response = await handler(signed(body));
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("not_configured");
    expect(record).not.toHaveBeenCalled();
  });

  it("refuses requests not signed with the secret, recording nothing", async () => {
    const { handler, record } = setup();
    for (const request of [
      signed(body, `${SECRET}_other`),
      new Request("https://costs.example.com/api/stripe/webhook", {
        method: "POST",
        body,
      }),
    ]) {
      const response = await handler(request);
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe("invalid_signature");
    }
    expect(record).not.toHaveBeenCalled();
  });

  it("refuses a signed body that isn't an event, and oversized ones", async () => {
    const { handler, record } = setup();
    const notEvent = await handler(signed("{}"));
    expect(notEvent.status).toBe(400);
    expect((await notEvent.json()).error.code).toBe("invalid_event");
    const huge = await handler(signed("x".repeat(256 * 1024 + 1)));
    expect(huge.status).toBe(413);
    expect(record).not.toHaveBeenCalled();
  });
});
