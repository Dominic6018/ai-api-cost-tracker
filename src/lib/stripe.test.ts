import { describe, expect, it, vi } from "vitest";
import {
  createStripeClient,
  formEncode,
  microsToCents,
  parseStripeConfig,
  StripeError,
} from "./stripe";

// Made-up keys, shaped like Stripe's; assembled here so secret scanners
// don't mistake them for real ones.
const fake = (mode: string) =>
  ["sk", mode, "51FakeKeyForUnitTestsOnly"].join("_");
const TEST_KEY = fake("test");
const LIVE_KEY = fake("live");

describe("parseStripeConfig", () => {
  it("is off without a key, saying how to turn it on", () => {
    const config = parseStripeConfig({});
    expect(config).toMatchObject({ enabled: false });
    if (!config.enabled) expect(config.reason).toMatch(/STRIPE_SECRET_KEY/);
  });

  it("accepts test secret and restricted keys", () => {
    expect(parseStripeConfig({ STRIPE_SECRET_KEY: TEST_KEY })).toEqual({
      enabled: true,
      secretKey: TEST_KEY,
      mode: "test",
    });
    expect(
      parseStripeConfig({ STRIPE_SECRET_KEY: " rk_test_abc123 " }),
    ).toMatchObject({ enabled: true, mode: "test" });
  });

  it("refuses a live key unless live mode is asked for", () => {
    const refused = parseStripeConfig({ STRIPE_SECRET_KEY: LIVE_KEY });
    expect(refused).toMatchObject({ enabled: false });
    if (!refused.enabled) {
      expect(refused.reason).toMatch(/real money/);
      expect(refused.reason).not.toContain(LIVE_KEY);
    }
    expect(
      parseStripeConfig({
        STRIPE_SECRET_KEY: LIVE_KEY,
        STRIPE_ALLOW_LIVE: "1",
      }),
    ).toMatchObject({ enabled: false });
    expect(
      parseStripeConfig({
        STRIPE_SECRET_KEY: LIVE_KEY,
        STRIPE_ALLOW_LIVE: "true",
      }),
    ).toMatchObject({ enabled: true, mode: "live" });
  });

  it("refuses publishable keys and anything else, without echoing them", () => {
    for (const key of ["pk_test_abc123", "whsec_abc123", "not a key"]) {
      const config = parseStripeConfig({ STRIPE_SECRET_KEY: key });
      expect(config.enabled, key).toBe(false);
      if (!config.enabled) expect(config.reason).not.toContain(key);
    }
  });
});

describe("formEncode", () => {
  it("encodes nested objects the way Stripe reads them", () => {
    expect(
      formEncode({
        customer: "cus_1",
        amount: "4900",
        metadata: { ledger_entry_id: "e 1", empty: undefined },
        description: "Pro plan, 2026-10 & more",
      }),
    ).toBe(
      "customer=cus_1&amount=4900&metadata%5Bledger_entry_id%5D=e%201&description=Pro%20plan%2C%202026-10%20%26%20more",
    );
  });
});

describe("microsToCents", () => {
  it("rounds to whole cents, half away from zero", () => {
    expect(microsToCents(49_000_000n)).toBe(4900n);
    expect(microsToCents(17_500_001n)).toBe(1750n);
    expect(microsToCents(5_000n)).toBe(1n);
    expect(microsToCents(4_999n)).toBe(0n);
    expect(microsToCents(-2_505_000n)).toBe(-251n);
    expect(microsToCents(-4_999n)).toBe(0n);
  });
});

describe("createStripeClient", () => {
  const config = {
    enabled: true as const,
    secretKey: TEST_KEY,
    mode: "test" as const,
  };

  it("POSTs form data with the key and an idempotency key", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ id: "in_123", object: "invoice" })),
      );
    const client = createStripeClient(config, fetch);
    expect(
      await client.post(
        "/invoices",
        { customer: "cus_1" },
        "tracker-invoice-x",
      ),
    ).toMatchObject({ id: "in_123" });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("https://api.stripe.com/v1/invoices");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      authorization: `Bearer ${TEST_KEY}`,
      "content-type": "application/x-www-form-urlencoded",
      "idempotency-key": "tracker-invoice-x",
    });
    expect(init.body).toBe("customer=cus_1");
  });

  it("turns Stripe errors and unreachable networks into StripeError", async () => {
    const refused = createStripeClient(
      config,
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              message: "No such customer: 'cus_x'",
              code: "resource_missing",
            },
          }),
          { status: 400 },
        ),
      ),
    );
    await expect(refused.post("/invoices", {}, "k")).rejects.toMatchObject({
      name: "StripeError",
      status: 400,
      code: "resource_missing",
      message: expect.stringContaining("No such customer"),
    });

    const offline = createStripeClient(
      config,
      vi.fn().mockRejectedValue(new TypeError("fetch failed")),
    );
    await expect(offline.post("/invoices", {}, "k")).rejects.toBeInstanceOf(
      StripeError,
    );

    // A 200 without an object is no better.
    const empty = createStripeClient(
      config,
      vi.fn().mockResolvedValue(new Response("{}")),
    );
    await expect(empty.post("/invoices", {}, "k")).rejects.toBeInstanceOf(
      StripeError,
    );
  });
});
