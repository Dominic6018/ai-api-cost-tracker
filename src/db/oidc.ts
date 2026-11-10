import { eq } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { TablesRelationalConfig } from "drizzle-orm/relations";
import { normalizeEmail, type SessionUser } from "./auth";
import { users } from "./schema";

/**
 * The existing account a verified identity signs in as. No account is ever
 * created here. The first sign-in binds the provider's subject to the
 * account; afterwards only that subject may use it, so an email address
 * later reassigned to someone else at the provider can't take it over.
 */
export async function accountForSso<
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
>(
  // Generic, so both the app's schema-aware database and plain ones fit.
  db: Pick<PgDatabase<TQueryResult, TFullSchema, TSchema>, "transaction">,
  { email, subject }: { email: string; subject: string },
): Promise<SessionUser | null> {
  return db.transaction(async (tx) => {
    const [user] = await tx
      .select({
        id: users.id,
        email: users.email,
        role: users.role,
        organizationId: users.organizationId,
        oidcSubject: users.oidcSubject,
      })
      .from(users)
      .where(eq(users.email, normalizeEmail(email)))
      .for("update");
    if (!user) return null;
    if (user.oidcSubject !== null && user.oidcSubject !== subject) return null;
    if (user.oidcSubject === null) {
      // Unique: a subject already bound to another account fails here.
      // In a savepoint: a failed statement would otherwise abort the whole
      // transaction, even once caught.
      const bound = await tx
        .transaction((sp) =>
          sp
            .update(users)
            .set({ oidcSubject: subject })
            .where(eq(users.id, user.id))
            .returning({ id: users.id }),
        )
        .catch(() => []);
      if (bound.length === 0) return null;
    }
    const { oidcSubject, ...sessionUser } = user;
    void oidcSubject;
    return sessionUser;
  });
}
