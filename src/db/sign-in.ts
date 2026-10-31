import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { RATE_LIMITS, rateLimitKey } from "@/lib/rate-limit";
import { normalizeEmail, verifyCredentials, type SessionUser } from "./auth";
import { clearRateLimit, hitRateLimit, undoRateLimitHit } from "./rate-limits";

/** Any Drizzle Postgres database, so callers and tests can pass their own. */
type Database = Pick<
  PgDatabase<PgQueryResultHKT>,
  "select" | "insert" | "update" | "delete"
>;

export type SignInResult =
  | { ok: true; user: SessionUser }
  | { ok: false; error: "invalid_credentials" | "rate_limited" };

/**
 * Checks credentials, limited per email address and per client IP. The
 * attempt is counted before the slow password check, so parallel guesses
 * can't race past the limit; a successful sign-in gives its attempt back.
 */
export async function signIn(
  db: Database,
  {
    email,
    password,
    clientIp,
  }: { email: string; password: string; clientIp: string },
  now: Date = new Date(),
): Promise<SignInResult> {
  const emailKey = rateLimitKey(RATE_LIMITS.signInEmail, normalizeEmail(email));
  const ipKey = rateLimitKey(RATE_LIMITS.signInIp, clientIp);
  const [byEmail, byIp] = await Promise.all([
    hitRateLimit(db, RATE_LIMITS.signInEmail, emailKey, now),
    hitRateLimit(db, RATE_LIMITS.signInIp, ipKey, now),
  ]);
  if (byEmail.limited || byIp.limited) {
    return { ok: false, error: "rate_limited" };
  }

  const user = await verifyCredentials(db, { email, password });
  if (!user) return { ok: false, error: "invalid_credentials" };

  await Promise.all([
    clearRateLimit(db, emailKey),
    undoRateLimitHit(db, ipKey, now),
  ]);
  return { ok: true, user };
}
