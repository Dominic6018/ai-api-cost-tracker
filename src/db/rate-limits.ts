import { and, eq, gt, lte, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { RateLimitRule } from "@/lib/rate-limit";
import { rateLimits } from "./schema";

/** Any Drizzle Postgres database, so callers and tests can pass their own. */
type Database = Pick<
  PgDatabase<PgQueryResultHKT>,
  "insert" | "update" | "delete"
>;

export interface RateLimitResult {
  /** True when this attempt is over the rule's limit and should be refused. */
  limited: boolean;
  /** When the current window ends and the count starts again. */
  resetAt: Date;
}

/**
 * Counts one attempt against `key` in a single atomic upsert, so concurrent
 * attempts can't slip past the limit. A window that has ended starts over.
 */
export async function hitRateLimit(
  db: Database,
  rule: RateLimitRule,
  key: string,
  now: Date = new Date(),
): Promise<RateLimitResult> {
  const expired = sql`${rateLimits.resetAt} <= ${now.toISOString()}::timestamptz`;
  const [row] = await db
    .insert(rateLimits)
    .values({ key, count: 1, resetAt: new Date(now.getTime() + rule.windowMs) })
    .onConflictDoUpdate({
      target: rateLimits.key,
      set: {
        count: sql`CASE WHEN ${expired} THEN 1 ELSE ${rateLimits.count} + 1 END`,
        resetAt: sql`CASE WHEN ${expired} THEN excluded.reset_at ELSE ${rateLimits.resetAt} END`,
      },
    })
    .returning({ count: rateLimits.count, resetAt: rateLimits.resetAt });
  // Attempts are where counters pile up, so clear out ended windows here.
  await deleteExpiredRateLimits(db, now);
  return { limited: row.count > rule.limit, resetAt: row.resetAt };
}

/** Takes back one counted attempt, e.g. one that turned out to succeed. */
export async function undoRateLimitHit(
  db: Database,
  key: string,
  now: Date = new Date(),
): Promise<void> {
  await db
    .update(rateLimits)
    .set({ count: sql`${rateLimits.count} - 1` })
    .where(
      and(
        eq(rateLimits.key, key),
        gt(rateLimits.count, 0),
        gt(rateLimits.resetAt, now),
      ),
    );
}

export async function clearRateLimit(db: Database, key: string) {
  await db.delete(rateLimits).where(eq(rateLimits.key, key));
}

/** Removes counters whose window has ended; returns how many were deleted. */
export async function deleteExpiredRateLimits(
  db: Database,
  now: Date = new Date(),
): Promise<number> {
  const deleted = await db
    .delete(rateLimits)
    .where(lte(rateLimits.resetAt, now))
    .returning({ key: rateLimits.key });
  return deleted.length;
}
