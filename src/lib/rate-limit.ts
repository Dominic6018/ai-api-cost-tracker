import { createHash } from "node:crypto";

export interface RateLimitRule {
  /** Prefix that keeps each rule's counters apart. */
  scope: string;
  /** Attempts allowed per window; the next one is refused. */
  limit: number;
  windowMs: number;
}

const FIFTEEN_MINUTES = 15 * 60 * 1000;

export const RATE_LIMITS = {
  /** Sign-in attempts per email address; a successful sign-in resets it. */
  signInEmail: { scope: "sign-in:email", limit: 5, windowMs: FIFTEEN_MINUTES },
  /** Failed sign-ins per client IP, across all email addresses. */
  signInIp: { scope: "sign-in:ip", limit: 20, windowMs: FIFTEEN_MINUTES },
  /** Rejected API keys per client IP. */
  apiKeyIp: { scope: "api-key:ip", limit: 30, windowMs: FIFTEEN_MINUTES },
} as const satisfies Record<string, RateLimitRule>;

/** The stored key for `value` under a rule. Hashed, so emails and IPs aren't stored. */
export function rateLimitKey(rule: RateLimitRule, value: string): string {
  const digest = createHash("sha256").update(value).digest("hex");
  return `${rule.scope}:${digest}`;
}

/**
 * The client IP as seen by the nearest proxy: the last X-Forwarded-For
 * entry, which a proxy such as Caddy or nginx sets or appends itself.
 * Next.js fills the header from the socket when no proxy set it.
 */
export function clientIp(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  const last = forwarded
    ?.split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .at(-1);
  return last || headers.get("x-real-ip")?.trim() || "unknown";
}

/** Whole seconds until `resetAt`, at least 1, for a Retry-After header. */
export function retryAfterSeconds(resetAt: Date, now: Date): number {
  return Math.max(1, Math.ceil((resetAt.getTime() - now.getTime()) / 1000));
}
