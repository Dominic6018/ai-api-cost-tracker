/**
 * A small Stripe API client for invoicing what the billing ledger says
 * customers owe. Stripe is optional: without STRIPE_SECRET_KEY nothing
 * here runs. Test keys are the default; a live key needs
 * STRIPE_ALLOW_LIVE=true as well, so real money is never charged by
 * accident.
 */

const API = "https://api.stripe.com/v1";

export type StripeConfig =
  | { enabled: false; reason: string }
  | { enabled: true; secretKey: string; mode: "test" | "live" };

/** Reads Stripe settings from the environment, without the key in errors. */
export function parseStripeConfig(
  env: Record<string, string | undefined> = process.env,
): StripeConfig {
  const key = env.STRIPE_SECRET_KEY?.trim();
  if (!key) {
    return {
      enabled: false,
      reason:
        "Stripe isn't set up: set STRIPE_SECRET_KEY to a test secret key (sk_test_...) in .env, which the npm run commands read.",
    };
  }
  const match = /^(sk|rk)_(test|live)_[A-Za-z0-9]+$/.exec(key);
  if (!match) {
    return {
      enabled: false,
      reason:
        "STRIPE_SECRET_KEY isn't a Stripe secret key: it should start with sk_test_ (or rk_test_ for a restricted key).",
    };
  }
  const mode = match[2] as "test" | "live";
  if (mode === "live" && env.STRIPE_ALLOW_LIVE !== "true") {
    return {
      enabled: false,
      reason:
        "STRIPE_SECRET_KEY is a live key, which charges real money. Use a test key, or set STRIPE_ALLOW_LIVE=true if you mean it.",
    };
  }
  return { enabled: true, secretKey: key, mode };
}

/**
 * Stripe's form encoding, with nested objects as `a[b]=c`. Undefined
 * values are left out.
 */
export function formEncode(params: Record<string, unknown>): string {
  const pairs: string[] = [];
  const add = (key: string, value: unknown) => {
    if (value === undefined || value === null) return;
    if (typeof value === "object") {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        add(`${key}[${k}]`, v);
      }
      return;
    }
    pairs.push(
      `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`,
    );
  };
  for (const [key, value] of Object.entries(params)) add(key, value);
  return pairs.join("&");
}

/**
 * Micro-dollars as whole cents, rounded half away from zero: Stripe
 * amounts are integers in the currency's smallest unit.
 */
export function microsToCents(micros: bigint): bigint {
  const negative = micros < 0n;
  const abs = negative ? -micros : micros;
  const cents = (abs + 5_000n) / 10_000n;
  return negative ? -cents : cents;
}

export class StripeError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly code: string | null,
  ) {
    super(message);
    this.name = "StripeError";
  }
}

export interface StripeClient {
  mode: "test" | "live";
  /**
   * POSTs to the API. The idempotency key makes a retry return the first
   * result instead of creating a second object (Stripe keeps keys for at
   * least 24 hours).
   */
  post<T extends { id: string }>(
    path: string,
    params: Record<string, unknown>,
    idempotencyKey: string,
  ): Promise<T>;
}

export function createStripeClient(
  config: Extract<StripeConfig, { enabled: true }>,
  fetchImpl: typeof fetch = fetch,
): StripeClient {
  return {
    mode: config.mode,
    async post<T extends { id: string }>(
      path: string,
      params: Record<string, unknown>,
      idempotencyKey: string,
    ): Promise<T> {
      let response: Response;
      try {
        response = await fetchImpl(`${API}${path}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${config.secretKey}`,
            "content-type": "application/x-www-form-urlencoded",
            "idempotency-key": idempotencyKey,
          },
          body: formEncode(params),
          signal: AbortSignal.timeout(20_000),
        });
      } catch (error) {
        throw new StripeError(
          `Couldn't reach Stripe: ${error instanceof Error ? error.message : String(error)}`,
          null,
          null,
        );
      }
      const body = (await response.json().catch(() => null)) as {
        id?: string;
        error?: { message?: string; code?: string };
      } | null;
      if (!response.ok || !body?.id) {
        throw new StripeError(
          `Stripe refused ${path}: ${body?.error?.message ?? `HTTP ${response.status}`}`,
          response.status,
          body?.error?.code ?? null,
        );
      }
      return body as T;
    },
  };
}
