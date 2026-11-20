import { and, asc, count, eq, gt } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { TablesRelationalConfig } from "drizzle-orm/relations";
import { isUuid } from "@/lib/ids";
import { hashPassword } from "@/lib/passwords";
import { RATE_LIMITS, rateLimitKey } from "@/lib/rate-limit";
import { normalizeEmail } from "./auth";
import { clearRateLimit } from "./rate-limits";
import { sessions, users, type UserRole } from "./schema";

/** Any Drizzle Postgres database, so the CLI and tests can pass their own. */
type Database = Pick<PgDatabase<PgQueryResultHKT>, "select" | "transaction">;

export type AccountResult =
  | {
      ok: true;
      email: string;
      organizationId: string;
      revokedSessions: number;
    }
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
      .returning({
        id: users.id,
        email: users.email,
        organizationId: users.organizationId,
      });
    if (!user) return { ok: false, error: "user_not_found" } as const;

    const revoked = await tx
      .delete(sessions)
      .where(eq(sessions.userId, user.id))
      .returning({ id: sessions.id });
    await clearRateLimit(tx, rateLimitKey(RATE_LIMITS.signInEmail, user.email));
    return {
      ok: true,
      email: user.email,
      organizationId: user.organizationId,
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
      .select({
        id: users.id,
        email: users.email,
        organizationId: users.organizationId,
      })
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
      organizationId: user.organizationId,
      revokedSessions: revoked.length,
    } as const;
  });
}

/**
 * Changes what an account may do. Roles are read on every request, so it
 * applies straight away, without signing the user out.
 */
export async function setUserRole(
  db: Pick<Database, "transaction">,
  { email, role }: { email: string; role: UserRole },
): Promise<
  | {
      ok: true;
      email: string;
      organizationId: string;
      role: UserRole;
      previousRole: UserRole;
    }
  | { ok: false; error: "user_not_found" }
> {
  return db.transaction(async (tx) => {
    const where = eq(users.email, normalizeEmail(email));
    const [before] = await tx
      .select({ role: users.role })
      .from(users)
      .where(where)
      .for("update");
    if (!before) return { ok: false, error: "user_not_found" } as const;
    const [user] = await tx.update(users).set({ role }).where(where).returning({
      email: users.email,
      organizationId: users.organizationId,
      role: users.role,
    });
    return { ok: true, ...user, previousRole: before.role } as const;
  });
}

export interface AccountSummary {
  email: string;
  role: UserRole;
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
      role: users.role,
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

export interface OrganizationAccount extends AccountSummary {
  id: string;
}

/**
 * The accounts in one organization, by email, with their active session
 * counts. Never returns hashes or sign-in subjects.
 */
export async function listOrganizationAccounts(
  db: Pick<Database, "select">,
  organizationId: string,
  now: Date = new Date(),
): Promise<OrganizationAccount[]> {
  const active = db
    .select({ userId: sessions.userId, n: count().as("n") })
    .from(sessions)
    .where(gt(sessions.expiresAt, now))
    .groupBy(sessions.userId)
    .as("active");
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      role: users.role,
      createdAt: users.createdAt,
      activeSessions: active.n,
    })
    .from(users)
    .leftJoin(active, eq(active.userId, users.id))
    .where(eq(users.organizationId, organizationId))
    .orderBy(asc(users.email));
  return rows.map((row) => ({
    ...row,
    activeSessions: Number(row.activeSessions ?? 0),
  }));
}

export type ChangeRoleResult =
  | {
      ok: true;
      email: string;
      role: UserRole;
      previousRole: UserRole;
    }
  | { ok: false; error: "not_found" | "last_admin" };

/**
 * Changes the role of an account in `organizationId`, as the dashboard
 * does. Refuses to leave the organization without an admin, who alone
 * can manage it. Its admins are locked first, so two admins demoting
 * each other at once can't both succeed.
 */
export async function changeAccountRole<
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
>(
  // Generic, so both the app's schema-aware database and plain ones fit.
  db: Pick<PgDatabase<TQueryResult, TFullSchema, TSchema>, "transaction">,
  {
    organizationId,
    userId,
    role,
  }: { organizationId: string; userId: string; role: UserRole },
): Promise<ChangeRoleResult> {
  if (!isUuid(userId)) return { ok: false, error: "not_found" };
  return db.transaction(async (tx) => {
    const inOrganization = and(
      eq(users.id, userId),
      eq(users.organizationId, organizationId),
    );
    const admins = await tx
      .select({ id: users.id })
      .from(users)
      .where(
        and(eq(users.organizationId, organizationId), eq(users.role, "admin")),
      )
      .orderBy(asc(users.id))
      .for("update");
    const [before] = await tx
      .select({ email: users.email, role: users.role })
      .from(users)
      .where(inOrganization)
      .for("update");
    if (!before) return { ok: false, error: "not_found" } as const;
    if (before.role === role) {
      return { ok: true, email: before.email, role, previousRole: role };
    }
    if (before.role === "admin" && admins.length <= 1) {
      return { ok: false, error: "last_admin" } as const;
    }
    await tx.update(users).set({ role }).where(inOrganization);
    return {
      ok: true,
      email: before.email,
      role,
      previousRole: before.role,
    } as const;
  });
}
