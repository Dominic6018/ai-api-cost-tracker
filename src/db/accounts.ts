import { asc, count, eq, gt } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { hashPassword } from "@/lib/passwords";
import { RATE_LIMITS, rateLimitKey } from "@/lib/rate-limit";
import { normalizeEmail } from "./auth";
import { clearRateLimit } from "./rate-limits";
import { sessions, users } from "./schema";

/** Any Drizzle Postgres database, so the CLI and tests can pass their own. */
type Database = Pick<PgDatabase<PgQueryResultHKT>, "select" | "transaction">;

export type AccountResult =
  | { ok: true; email: string; revokedSessions: number }
  | { ok: false; error: "user_not_found" };

/**
 * Sets a new password and signs the user out everywhere, in one
 * transaction. Also lifts any sign-in lockout on the email, so the
 * owner can sign in with the new password straight away.
 */
export async function resetPassword(
  db: Database,
  { email, password }: { email: string; password: string },
): Promise<AccountResult> {
  // Hashed outside the transaction, which shouldn't wait on scrypt.
  const passwordHash = await hashPassword(password);
  return db.transaction(async (tx) => {
    const [user] = await tx
      .update(users)
      .set({ passwordHash })
      .where(eq(users.email, normalizeEmail(email)))
      .returning({ id: users.id, email: users.email });
    if (!user) return { ok: false, error: "user_not_found" } as const;

    const revoked = await tx
      .delete(sessions)
      .where(eq(sessions.userId, user.id))
      .returning({ id: sessions.id });
    await clearRateLimit(tx, rateLimitKey(RATE_LIMITS.signInEmail, user.email));
    return {
      ok: true,
      email: user.email,
      revokedSessions: revoked.length,
    } as const;
  });
}

/** Signs a user out everywhere by deleting all of their sessions. */
export async function revokeSessions(
  db: Database,
  email: string,
): Promise<AccountResult> {
  return db.transaction(async (tx) => {
    const [user] = await tx
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(eq(users.email, normalizeEmail(email)));
    if (!user) return { ok: false, error: "user_not_found" } as const;

    const revoked = await tx
      .delete(sessions)
      .where(eq(sessions.userId, user.id))
      .returning({ id: sessions.id });
    return {
      ok: true,
      email: user.email,
      revokedSessions: revoked.length,
    } as const;
  });
}

export interface AccountSummary {
  email: string;
  createdAt: Date;
  /** Unexpired sessions; expired ones can't sign anyone in. */
  activeSessions: number;
}

/** Every account with its active session count. Never returns hashes. */
export async function listUsers(
  db: Pick<Database, "select">,
  now: Date = new Date(),
): Promise<AccountSummary[]> {
  const active = db
    .select({ userId: sessions.userId, n: count().as("n") })
    .from(sessions)
    .where(gt(sessions.expiresAt, now))
    .groupBy(sessions.userId)
    .as("active");
  const rows = await db
    .select({
      email: users.email,
      createdAt: users.createdAt,
      activeSessions: active.n,
    })
    .from(users)
    .leftJoin(active, eq(active.userId, users.id))
    .orderBy(asc(users.email));
  return rows.map((row) => ({
    ...row,
    activeSessions: Number(row.activeSessions ?? 0),
  }));
}
