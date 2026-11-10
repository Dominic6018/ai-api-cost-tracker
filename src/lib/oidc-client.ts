import "server-only";
import * as client from "openid-client";
import type { OidcConfig } from "./oidc";

/** Discovery runs once per process; a failure is retried on the next use. */
let cached: { key: string; config: Promise<client.Configuration> } | undefined;

function configuration(oidc: OidcConfig): Promise<client.Configuration> {
  const key = `${oidc.issuer}|${oidc.clientId}`;
  if (cached?.key !== key) {
    const config = client
      .discovery(
        new URL(oidc.issuer),
        oidc.clientId,
        oidc.clientSecret,
        oidc.clientSecret ? undefined : client.None(),
        oidc.allowHttp
          ? { execute: [client.allowInsecureRequests] }
          : undefined,
      )
      .catch((error: unknown) => {
        cached = undefined;
        throw error;
      });
    cached = { key, config };
  }
  return cached.config;
}

/** What the callback must check, kept in a short-lived cookie. */
export interface SsoChecks {
  state: string;
  nonce: string;
  codeVerifier: string;
  /** Where to go after signing in; already a safe local path. */
  next: string;
}

/** The provider's authorization URL, and the checks to keep for the callback. */
export async function startSso(
  oidc: OidcConfig,
  next: string,
): Promise<{ url: URL; checks: SsoChecks }> {
  const config = await configuration(oidc);
  const codeVerifier = client.randomPKCECodeVerifier();
  const checks: SsoChecks = {
    state: client.randomState(),
    nonce: client.randomNonce(),
    codeVerifier,
    next,
  };
  const url = client.buildAuthorizationUrl(config, {
    redirect_uri: oidc.redirectUri,
    scope: "openid email profile",
    code_challenge: await client.calculatePKCECodeChallenge(codeVerifier),
    code_challenge_method: "S256",
    state: checks.state,
    nonce: checks.nonce,
  });
  return { url, checks };
}

/**
 * Exchanges the code for tokens and returns the validated ID token's
 * claims. openid-client checks the state, the PKCE verifier, and the ID
 * token's signature, issuer, audience, expiry and nonce; any failure
 * throws.
 */
export async function finishSso(
  oidc: OidcConfig,
  callbackSearch: URLSearchParams,
  checks: SsoChecks,
): Promise<Record<string, unknown>> {
  const config = await configuration(oidc);
  // Built from the registered redirect URI, not the request's host, which
  // a proxy may have rewritten.
  const currentUrl = new URL(oidc.redirectUri);
  currentUrl.search = callbackSearch.toString();
  const tokens = await client.authorizationCodeGrant(config, currentUrl, {
    pkceCodeVerifier: checks.codeVerifier,
    expectedState: checks.state,
    expectedNonce: checks.nonce,
    idTokenExpected: true,
  });
  const claims = tokens.claims();
  if (!claims) throw new Error("No ID token");
  return claims as Record<string, unknown>;
}
