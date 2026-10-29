import { and, eq, gt, lte } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { hashPassword, verifyPassword } from "@/lib/passwords";
import {
  generateSessionToken,
  hashSessionToken,
  SESSION_TTL_MS,
} from "@/lib/sessions";
import { sessions, users, type User } from "./schema";

/** Any Drizzle Postgres database, so callers and tests can pass their own. */
type Database = Pick<
  PgDatabase<PgQueryResultHKT>,
  "select" | "insert" | "delete"
>;

const UNIQUE_VIOLATION = "23505";

function pgErrorCode(error: unknown): string | undefined {
  const cause = (error as { cause?: unknown })?.cause ?? error;
  const code = (cause as { code?: unknown })?.code;
  return typeof code === "string" ? code : undefined;
}

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

/** The fields of a user that are safe to hand to pages. */
export type SessionUser = Pick<User, "id" | "email">;

export type CreateUserResult =
  { ok: true; user: SessionUser } | { ok: false; error: "email_taken" };

export async function createUser(
  db: Database,
  { email, password }: { email: string; password: string },
): Promise<CreateUserResult> {
  try {
    const [user] = await db
      .insert(users)
      .values({
        email: normalizeEmail(email),
        passwordHash: await hashPassword(password),
      })
      .returning({ id: users.id, email: users.email });
    return { ok: true, user };
  } catch (error) {
    if (pgErrorCode(error) === UNIQUE_VIOLATION) {
      return { ok: false, error: "email_taken" };
    }
    throw error;
  }
}

// Verified when the email is unknown, so both cases take about as long and
// response timing doesn't reveal which emails have accounts.
let dummyHash: Promise<string> | undefined;

/** Returns the user if the email and password match, otherwise null. */
export async function verifyCredentials(
  db: Database,
  { email, password }: { email: string; password: string },
): Promise<SessionUser | null> {
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, normalizeEmail(email)));

  if (!user) {
    dummyHash ??= hashPassword("not-a-real-password");
    await verifyPassword(password, await dummyHash);
    return null;
  }
  return (await verifyPassword(password, user.passwordHash))
    ? { id: user.id, email: user.email }
    : null;
}

/** Starts a session and returns the token to put in the cookie. */
export async function createSession(
  db: Database,
  userId: string,
  now: Date = new Date(),
): Promise<{ token: string; expiresAt: Date }> {
  const token = generateSessionToken();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  await db
    .insert(sessions)
    .values({ userId, tokenHash: hashSessionToken(token), expiresAt });
  return { token, expiresAt };
}

/** The user for an unexpired session token, or null. */
export async function getSessionUser(
  db: Database,
  token: string,
  now: Date = new Date(),
): Promise<SessionUser | null> {
  const [row] = await db
    .select({ id: users.id, email: users.email })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(
      and(
        eq(sessions.tokenHash, hashSessionToken(token)),
        gt(sessions.expiresAt, now),
      ),
    );
  return row ?? null;
}

export async function deleteSession(db: Database, token: string) {
  await db
    .delete(sessions)
    .where(eq(sessions.tokenHash, hashSessionToken(token)));
}

/** Removes expired sessions; returns how many were deleted. */
export async function deleteExpiredSessions(
  db: Database,
  now: Date = new Date(),
): Promise<number> {
  const deleted = await db
    .delete(sessions)
    .where(lte(sessions.expiresAt, now))
    .returning({ id: sessions.id });
  return deleted.length;
}
