import { desc } from "drizzle-orm";
import type {
  PgDatabase,
  PgQueryResultHKT,
  PgTransaction,
} from "drizzle-orm/pg-core";
import type { TablesRelationalConfig } from "drizzle-orm/relations";
import { AUDIT_PAGE_SIZE, type AuditEntry } from "@/lib/audit";
import { auditLog, type AuditLogEntry } from "./schema";

/** Who made a change. The label outlives the account it names. */
export interface AuditActor {
  userId: string | null;
  label: string;
}

export const COMMAND_LINE: AuditActor = {
  userId: null,
  label: "command line",
};

export const userActor = (user: { id: string; email: string }): AuditActor => ({
  userId: user.id,
  label: user.email,
});

/**
 * Runs a change and records it in one transaction, so a change is never
 * saved without its entry or the other way round. `change` returns the
 * entry to record, or null when nothing changed.
 */
export function audited<
  T,
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
>(
  // Generic, so both the app's schema-aware database and plain ones fit.
  db: Pick<PgDatabase<TQueryResult, TFullSchema, TSchema>, "transaction">,
  actor: AuditActor,
  change: (
    tx: PgTransaction<TQueryResult, TFullSchema, TSchema>,
  ) => Promise<{ result: T; entry: AuditEntry | null }>,
): Promise<T> {
  return db.transaction(async (tx) => {
    const { result, entry } = await change(tx);
    if (entry) {
      await tx.insert(auditLog).values({
        actorUserId: actor.userId,
        actorLabel: actor.label,
        ...entry,
      });
    }
    return result;
  });
}

/** A page of entries, newest first, and whether another page follows. */
export async function listAuditEntries(
  db: Pick<PgDatabase<PgQueryResultHKT>, "select">,
  page: number,
): Promise<{ entries: AuditLogEntry[]; hasMore: boolean }> {
  const rows = await db
    .select()
    .from(auditLog)
    .orderBy(desc(auditLog.occurredAt), desc(auditLog.id))
    .limit(AUDIT_PAGE_SIZE + 1)
    .offset((page - 1) * AUDIT_PAGE_SIZE);
  return {
    entries: rows.slice(0, AUDIT_PAGE_SIZE),
    hasMore: rows.length > AUDIT_PAGE_SIZE,
  };
}
