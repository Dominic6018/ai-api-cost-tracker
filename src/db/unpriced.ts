import { and, asc, eq, gt, gte, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { TablesRelationalConfig } from "drizzle-orm/relations";
import type { AuditActor } from "./audit";
import { audited } from "./audit";
import { projects, usageEvents, type UnpricedReason } from "./schema";
import { inOrganization, type OrganizationScope } from "./scope";
import { costColumns, priceUsage } from "./usage";

/** Unpriced usage since `since`: kept, but in no total until it's priced. */
export interface UnpricedSummary {
  events: number;
  /** The models waiting for a price, most events first. */
  models: Array<{
    provider: string;
    model: string;
    reason: UnpricedReason;
    events: number;
  }>;
}

export async function getUnpricedSummary(
  db: Pick<PgDatabase<PgQueryResultHKT>, "select">,
  scope: OrganizationScope,
  since: Date,
): Promise<UnpricedSummary> {
  const events = sql<number>`count(*)::int`;
  const rows = await db
    .select({
      provider: usageEvents.provider,
      model: usageEvents.model,
      reason: usageEvents.unpricedReason,
      events,
    })
    .from(usageEvents)
    .innerJoin(projects, eq(projects.id, usageEvents.projectId))
    .where(
      and(
        inOrganization(scope),
        eq(usageEvents.pricingStatus, "unpriced"),
        gte(usageEvents.occurredAt, since),
      ),
    )
    .groupBy(
      usageEvents.provider,
      usageEvents.model,
      usageEvents.unpricedReason,
    )
    .orderBy(sql`${events} desc`, usageEvents.provider, usageEvents.model);
  return {
    events: rows.reduce((sum, row) => sum + row.events, 0),
    models: rows.map((row) => ({
      ...row,
      reason: row.reason as UnpricedReason,
    })),
  };
}

export interface RepriceResult {
  /** Unpriced events looked at. */
  checked: number;
  /** Events priced by this run. */
  priced: number;
  /** Events still waiting for a price, by what's missing. */
  stillUnpriced: Partial<Record<UnpricedReason, number>>;
}

const PAGE_SIZE = 500;

/**
 * Prices unpriced usage with the rates now stored for when it occurred.
 * Each event is priced at most once: the update only applies to a row
 * that's still unpriced, so overlapping runs can't both price it. Each
 * page is saved with its own audit entry, in one transaction.
 */
export async function repriceUnpriced<
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
>(
  db: Pick<
    PgDatabase<TQueryResult, TFullSchema, TSchema>,
    "select" | "transaction"
  >,
  actor: AuditActor,
  { dryRun = false }: { dryRun?: boolean } = {},
): Promise<RepriceResult> {
  const result: RepriceResult = { checked: 0, priced: 0, stillUnpriced: {} };
  let after: string | undefined;
  for (;;) {
    const page = await db
      .select()
      .from(usageEvents)
      .where(
        and(
          eq(usageEvents.pricingStatus, "unpriced"),
          after ? gt(usageEvents.id, after) : undefined,
        ),
      )
      .orderBy(asc(usageEvents.id))
      .limit(PAGE_SIZE);
    if (page.length === 0) return result;
    after = page.at(-1)!.id;
    result.checked += page.length;

    const priced = await audited(db, actor, async (tx) => {
      let n = 0;
      for (const event of page) {
        const price = await priceUsage(tx, {
          ...event,
          requestId: event.requestId ?? undefined,
          metadata: event.metadata ?? undefined,
          customerId: event.customerId ?? undefined,
          userId: event.userId ?? undefined,
          feature: event.feature ?? undefined,
          runId: event.runId ?? undefined,
          tags: event.tags ?? undefined,
        });
        if (!price.ok) {
          result.stillUnpriced[price.reason] =
            (result.stillUnpriced[price.reason] ?? 0) + 1;
          continue;
        }
        if (dryRun) {
          n++;
          continue;
        }
        const updated = await tx
          .update(usageEvents)
          .set(costColumns(price))
          .where(
            and(
              eq(usageEvents.id, event.id),
              eq(usageEvents.pricingStatus, "unpriced"),
            ),
          )
          .returning({ id: usageEvents.id });
        n += updated.length;
      }
      return {
        result: n,
        entry:
          n > 0 && !dryRun
            ? {
                action: "usage.repriced" as const,
                target: `${n} event(s)`,
                details: { priced: n },
              }
            : null,
      };
    });
    result.priced += priced;
  }
}
