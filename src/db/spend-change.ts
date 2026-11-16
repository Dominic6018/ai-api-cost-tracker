import { and, eq, gte, lt, or, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { ModelInput, Period } from "@/lib/spend-change";
import { usageEvents } from "./schema";
import { projectInOrganization, type OrganizationScope } from "./scope";

type Database = Pick<PgDatabase<PgQueryResultHKT>, "select">;

export interface SpendChangeInputs {
  models: ModelInput[];
  /** Requests with no price yet in each period, left out of the figures. */
  unpriced: { before: number; after: number };
}

/**
 * Each model's priced requests, tokens and cost in the two periods, for
 * an organization (or one of its projects). Unpriced requests are left
 * out, since they have no cost, and counted so the page can say so.
 */
export async function getSpendChangeInputs(
  db: Database,
  scope: OrganizationScope,
  periods: { before: Period; after: Period },
  projectId?: string,
): Promise<SpendChangeInputs> {
  const iso = (d: Date) => d.toISOString();
  const within = (p: Period) =>
    sql`${usageEvents.occurredAt} >= ${iso(p.from)}::timestamptz and ${usageEvents.occurredAt} < ${iso(p.to)}::timestamptz`;
  const priced = sql`${usageEvents.pricingStatus} = 'priced'`;
  const sums = (p: Period) => ({
    requests: sql<string>`count(*) filter (where ${priced} and ${within(p)})::text`,
    tokens: sql<string>`coalesce(sum(${usageEvents.inputTokens}::bigint + ${usageEvents.outputTokens}) filter (where ${priced} and ${within(p)}), 0)::text`,
    cost: sql<string>`coalesce(sum(${usageEvents.costUsd}) filter (where ${priced} and ${within(p)}), 0)::numeric(18, 6)::text`,
    unpriced: sql<number>`count(*) filter (where not ${priced} and ${within(p)})::int`,
  });
  const before = sums(periods.before);
  const after = sums(periods.after);

  const rows = await db
    .select({
      provider: usageEvents.provider,
      model: usageEvents.model,
      beforeRequests: before.requests,
      beforeTokens: before.tokens,
      beforeCost: before.cost,
      beforeUnpriced: before.unpriced,
      afterRequests: after.requests,
      afterTokens: after.tokens,
      afterCost: after.cost,
      afterUnpriced: after.unpriced,
    })
    .from(usageEvents)
    .where(
      and(
        projectInOrganization(usageEvents.projectId, scope),
        projectId ? eq(usageEvents.projectId, projectId) : undefined,
        or(
          and(
            gte(usageEvents.occurredAt, periods.before.from),
            lt(usageEvents.occurredAt, periods.before.to),
          ),
          and(
            gte(usageEvents.occurredAt, periods.after.from),
            lt(usageEvents.occurredAt, periods.after.to),
          ),
        ),
      ),
    )
    .groupBy(usageEvents.provider, usageEvents.model);

  const micros = (usd: string) => {
    const [whole, fraction = ""] = usd.split(".");
    return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  };
  const period = (requests: string, tokens: string, cost: string) =>
    BigInt(requests) === 0n
      ? null
      : {
          requests: BigInt(requests),
          tokens: BigInt(tokens),
          costMicros: micros(cost),
        };
  const models: ModelInput[] = [];
  const unpriced = { before: 0, after: 0 };
  for (const row of rows) {
    unpriced.before += row.beforeUnpriced;
    unpriced.after += row.afterUnpriced;
    const b = period(row.beforeRequests, row.beforeTokens, row.beforeCost);
    const a = period(row.afterRequests, row.afterTokens, row.afterCost);
    if (b || a) {
      models.push({
        provider: row.provider,
        model: row.model,
        before: b,
        after: a,
      });
    }
  }
  return { models, unpriced };
}
