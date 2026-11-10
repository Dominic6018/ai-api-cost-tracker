/**
 * Optional single sign-on with OpenID Connect: configuration, and the rule
 * for which account a verified identity may sign in as.
 */

import { z } from "zod";

export interface OidcConfig {
  issuer: string;
  clientId: string;
  /** Absent for a public client, which relies on PKCE alone. */
  clientSecret?: string;
  /** This app's callback, as registered with the provider. */
  redirectUri: string;
  /** Shown on the sign-in button, e.g. "Okta". */
  name: string;
  /** Plain-http issuer, for a local test provider only. */
  allowHttp: boolean;
}

const url = (name: string) =>
  z.url({ protocol: /^https?$/, error: `${name} must be an http(s) URL` });

const schema = z.object({
  OIDC_ISSUER: url("OIDC_ISSUER"),
  OIDC_CLIENT_ID: z.string().min(1, "OIDC_CLIENT_ID is required"),
  OIDC_CLIENT_SECRET: z.string().min(1).optional(),
  OIDC_REDIRECT_URI: url("OIDC_REDIRECT_URI"),
  OIDC_NAME: z.string().min(1).max(40).optional(),
  OIDC_ALLOW_HTTP: z.enum(["true", "false"]).optional(),
});

const KEYS = Object.keys(schema.shape) as Array<keyof typeof schema.shape>;

/**
 * Reads the configuration; null when single sign-on isn't set up. Empty
 * values count as unset. Throws a readable error for a partial or invalid
 * configuration, without repeating the client secret.
 */
export function parseOidcConfig(
  source: Record<string, string | undefined>,
): OidcConfig | null {
  const env = Object.fromEntries(
    KEYS.map((key) => [key, source[key]?.trim() || undefined]),
  );
  if (!env.OIDC_ISSUER && !env.OIDC_CLIENT_ID && !env.OIDC_REDIRECT_URI) {
    return null;
  }
  const result = schema.safeParse(env);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid single sign-on configuration:\n${details}`);
  }
  const data = result.data;
  const allowHttp = data.OIDC_ALLOW_HTTP === "true";
  for (const [key, value] of [
    ["OIDC_ISSUER", data.OIDC_ISSUER],
    ["OIDC_REDIRECT_URI", data.OIDC_REDIRECT_URI],
  ] as const) {
    if (!allowHttp && new URL(value).protocol !== "https:") {
      throw new Error(
        `Invalid single sign-on configuration:\n  - ${key} must use https (OIDC_ALLOW_HTTP=true is for a local test provider only)`,
      );
    }
  }
  return {
    issuer: data.OIDC_ISSUER,
    clientId: data.OIDC_CLIENT_ID,
    ...(data.OIDC_CLIENT_SECRET && { clientSecret: data.OIDC_CLIENT_SECRET }),
    redirectUri: data.OIDC_REDIRECT_URI,
    name: data.OIDC_NAME ?? "single sign-on",
    allowHttp,
  };
}

/** What a sign-in attempt can end in, as the sign-in page's `?error=`. */
export const SSO_ERRORS = {
  sso_failed:
    "Single sign-on didn't complete. Try again, or sign in with your password.",
  sso_denied:
    "This identity can't sign in here. Ask an admin to create your account, or sign in with your password.",
} as const;
export type SsoError = keyof typeof SSO_ERRORS;

/** The identity claims single sign-on needs from the ID token. */
export type SsoIdentity =
  { ok: true; subject: string; email: string } | { ok: false };

/**
 * An identity may only be matched to an account by an email the provider
 * says it has verified; without that, anyone who can set an email at the
 * provider could sign in as that account.
 */
export function ssoIdentity(claims: Record<string, unknown>): SsoIdentity {
  const { sub, email, email_verified: verified } = claims;
  if (typeof sub !== "string" || sub === "") return { ok: false };
  if (typeof email !== "string" || !email.includes("@")) return { ok: false };
  if (verified !== true && verified !== "true") return { ok: false };
  return { ok: true, subject: sub, email };
}
