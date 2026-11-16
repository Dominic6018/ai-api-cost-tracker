import { and, eq, gte, lt, or, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { ModelInput, Period, ReferencePrices } from "@/lib/spend-change";
import { findEffectivePricing } from "./pricing";
import { usageEvents, type Provider } from "./schema";
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
    // Token kinds, as the price table prices them.
    parts: sql<string>`concat_ws(',', ${[
      usageEvents.inputTokens,
      usageEvents.cachedInputTokens,
      usageEvents.cacheWriteInputTokens,
      usageEvents.cacheWrite1hInputTokens,
      usageEvents.outputTokens,
    ]
      .map(
        (column) =>
          sql`coalesce(sum(${column}::bigint) filter (where ${priced} and ${within(p)}), 0)`,
      )
      .reduce((list, part) => sql`${list}, ${part}`)})`,
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
      beforeParts: before.parts,
      beforeCost: before.cost,
      beforeUnpriced: before.unpriced,
      afterRequests: after.requests,
      afterTokens: after.tokens,
      afterParts: after.parts,
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
  const period = (
    requests: string,
    tokens: string,
    cost: string,
    parts: string,
  ) => {
    if (BigInt(requests) === 0n) return null;
    const [input, cached, writes, writes1h, output] = parts
      .split(",")
      .map((n) => BigInt(n));
    return {
      requests: BigInt(requests),
      tokens: BigInt(tokens),
      costMicros: micros(cost),
      parts: { input, cached, writes, writes1h, output },
    };
  };
  const models: ModelInput[] = [];
  const unpriced = { before: 0, after: 0 };
  for (const row of rows) {
    unpriced.before += row.beforeUnpriced;
    unpriced.after += row.afterUnpriced;
    const b = period(
      row.beforeRequests,
      row.beforeTokens,
      row.beforeCost,
      row.beforeParts,
    );
    const a = period(
      row.afterRequests,
      row.afterTokens,
      row.afterCost,
      row.afterParts,
    );
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

/**
 * Each model's standard rates at the end of each period, to split its
 * change in cost per token; null where there's no price. A model used in
 * only one period doesn't need them.
 */
export async function getReferencePrices(
  db: Database,
  models: ModelInput[],
  periods: { before: Period; after: Period },
): Promise<Map<string, ReferencePrices>> {
  const at = (p: Period) => new Date(p.to.getTime() - 1);
  const prices = new Map<string, ReferencePrices>();
  for (const m of models) {
    if (!m.before || !m.after) continue;
    const lookup = async (p: Period) => {
      const found = await findEffectivePricing(db, {
        provider: m.provider as Provider,
        model: m.model,
        at: at(p),
      });
      return found.found ? found.pricing : null;
    };
    prices.set(`${m.provider}/${m.model}`, {
      before: await lookup(periods.before),
      after: await lookup(periods.after),
    });
  }
  return prices;
}
