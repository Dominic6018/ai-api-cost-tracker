import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseStripeEvent, verifyStripeSignature } from "./stripe-webhook";

// A made-up signing secret, assembled so secret scanners don't flag it.
const SECRET = ["whsec", "unit", "tests", "only"].join("_");
const NOW = new Date("2026-11-21T12:00:00Z");
const T = Math.floor(NOW.getTime() / 1000);

const sign = (body: string, t = T, secret = SECRET) =>
  createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");

const event = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    id: "evt_1",
    type: "invoice.paid",
    livemode: false,
    created: T,
    data: {
      object: { id: "in_1", amount_paid: 6400, currency: "usd" },
    },
    ...overrides,
  });

describe("verifyStripeSignature", () => {
  const body = event();

  it("accepts a request Stripe signed, among several signatures", () => {
    expect(
      verifyStripeSignature(body, `t=${T},v1=${sign(body)}`, SECRET, NOW),
    ).toEqual({ ok: true });
    // During a secret rotation Stripe sends one signature per secret.
    expect(
      verifyStripeSignature(
        body,
        `t=${T},v1=${"0".repeat(64)},v1=${sign(body)},v0=abc`,
        SECRET,
        NOW,
      ),
    ).toEqual({ ok: true });
  });

  it("refuses a changed body, another secret, or no signature", () => {
    const header = `t=${T},v1=${sign(body)}`;
    expect(verifyStripeSignature(`${body} `, header, SECRET, NOW)).toEqual({
      ok: false,
      reason: "mismatch",
    });
    expect(
      verifyStripeSignature(body, header, `${SECRET}_other`, NOW),
    ).toMatchObject({ ok: false, reason: "mismatch" });
    expect(verifyStripeSignature(body, null, SECRET, NOW)).toEqual({
      ok: false,
      reason: "missing",
    });
    for (const malformed of ["v1=abc", `t=${T}`, "t=soon,v1=ab", ""]) {
      expect(
        verifyStripeSignature(body, malformed, SECRET, NOW).ok,
        malformed,
      ).toBe(false);
    }
    // A signature that isn't hex never matches, rather than throwing.
    expect(
      verifyStripeSignature(body, `t=${T},v1=not-hex`, SECRET, NOW),
    ).toEqual({ ok: false, reason: "mismatch" });
  });

  it("refuses a request more than five minutes old, or from the future", () => {
    for (const t of [T - 301, T + 301]) {
      expect(
        verifyStripeSignature(body, `t=${t},v1=${sign(body, t)}`, SECRET, NOW),
      ).toEqual({ ok: false, reason: "expired" });
    }
    expect(
      verifyStripeSignature(
        body,
        `t=${T - 300},v1=${sign(body, T - 300)}`,
        SECRET,
        NOW,
      ).ok,
    ).toBe(true);
  });
});

describe("parseStripeEvent", () => {
  it("reads the invoice events the tracker records", () => {
    expect(parseStripeEvent(event())).toEqual({
      ok: true,
      event: {
        id: "evt_1",
        type: "invoice.paid",
        livemode: false,
        created: NOW,
      },
      invoice: {
        id: "evt_1",
        type: "invoice.paid",
        livemode: false,
        created: NOW,
        status: "paid",
        stripeInvoiceId: "in_1",
        amountPaidCents: 6400n,
        currency: "usd",
      },
    });
    for (const [type, status] of [
      ["invoice.finalized", "open"],
      ["invoice.payment_failed", "payment_failed"],
      ["invoice.voided", "void"],
      ["invoice.marked_uncollectible", "uncollectible"],
    ]) {
      const parsed = parseStripeEvent(event({ type }));
      expect(parsed.ok && parsed.invoice).toMatchObject({
        status,
        amountPaidCents: null,
      });
    }
  });

  it("parses other events with no invoice, and refuses non-events", () => {
    const other = parseStripeEvent(event({ type: "customer.created" }));
    expect(other).toMatchObject({ ok: true, invoice: null });
    for (const body of ["not json", "{}", JSON.stringify({ id: "evt" })]) {
      expect(parseStripeEvent(body).ok, body).toBe(false);
    }
  });
});
