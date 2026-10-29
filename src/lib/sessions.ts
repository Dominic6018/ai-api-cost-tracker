import { createHash, randomBytes } from "node:crypto";

export const SESSION_COOKIE = "session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** A new session token from a cryptographically secure random source. */
export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Where to send the user after signing in. Only same-site paths are
 * allowed, so a crafted `next` parameter can't redirect off-site.
 */
export function safeRedirectPath(
  next: unknown,
  fallback = "/overview",
): string {
  if (typeof next !== "string") return fallback;
  if (!next.startsWith("/") || next.startsWith("//")) return fallback;
  if (next.includes("\\") || /[\u0000-\u001f]/.test(next)) return fallback;
  return next;
}
