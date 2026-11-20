/**
 * Secret links, such as invitations and customer portal links: the token
 * in the link is the credential, so only its hash is stored.
 */

import { generateSessionToken, hashSessionToken } from "./sessions";

/** A new token, 256 bits from a secure random source, and its hash. */
export function generateLinkToken(): { token: string; hash: string } {
  const token = generateSessionToken();
  return { token, hash: hashLinkToken(token) };
}

export const hashLinkToken = hashSessionToken;

/** Tokens are base64url of 32 bytes; anything else is refused unread. */
export function isWellFormedLinkToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(token);
}

/** A path's full address, from the request's own scheme and host. */
export function absoluteUrl(
  path: string,
  request: { host: string | null; proto: string | null },
): string {
  const host = request.host ?? "localhost:3000";
  const proto =
    request.proto?.split(",")[0]?.trim() ||
    (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}${path}`;
}
