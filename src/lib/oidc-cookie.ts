import type { SsoChecks } from "./oidc-client";
import type { OidcConfig } from "./oidc";

/** Holds the state, nonce and PKCE verifier between start and callback. */
export const SSO_COOKIE = "oidc_login";

/** Ten minutes to finish signing in at the provider. */
const MAX_AGE_SECONDS = 10 * 60;

export function ssoCookieOptions(oidc: OidcConfig) {
  return {
    httpOnly: true,
    // Lax, so it's sent on the provider's top-level redirect back.
    sameSite: "lax" as const,
    secure: new URL(oidc.redirectUri).protocol === "https:",
    path: "/login/oidc",
    maxAge: MAX_AGE_SECONDS,
  };
}

/** The checks from the cookie, or null if it's missing or malformed. */
export function readSsoChecks(value: string | undefined): SsoChecks | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<SsoChecks>;
    const fields = [
      parsed.state,
      parsed.nonce,
      parsed.codeVerifier,
      parsed.next,
    ];
    return fields.every((field) => typeof field === "string" && field !== "")
      ? (parsed as SsoChecks)
      : null;
  } catch {
    return null;
  }
}
