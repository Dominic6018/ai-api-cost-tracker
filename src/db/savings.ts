import { and, eq, gte, lt, sql } from "drizzle-orm";
import type {
  AnyPgColumn,
  PgDatabase,
  PgQueryResultHKT,
} from "drizzle-orm/pg-core";
import { selectEffectivePricing } from "@/lib/pricing";
import type { PriceOption, Workload } from "@/lib/savings";
import type { Period } from "@/lib/spend-change";
import { modelPricing, usageEvents } from "./schema";
import { projectInOrganization, type OrganizationScope } from "./scope";

type Database = Pick<PgDatabase<PgQueryResultHKT>, "select">;

export interface SavingsInputs {
  workloads: Workload[];
  /** Requests with no price yet, which no estimate includes. */
  unpriced: number;
  /** Priced requests at another tier (batch, flex, fast), left out. */
  otherTiers: number;
}

/**
 * Each model's priced, standard-tier usage in the period: requests, cost
 * and tokens by kind, for an organization or one of its projects.
 */
export async function getSavingsInputs(
  db: Database,
  scope: OrganizationScope,
  period: Period,
  projectId?: string,
): Promise<SavingsInputs> {
  const standard = sql`${usageEvents.pricingStatus} = 'priced' and ${usageEvents.serviceTier} = 'standard'`;
  const tokens = (column: AnyPgColumn) =>
    sql<string>`coalesce(sum(${column}::bigint) filter (where ${standard}), 0)::text`;
  const rows = await db
    .select({
      provider: usageEvents.provider,
      model: usageEvents.model,
      requests: sql<string>`count(*) filter (where ${standard})::text`,
      cost: sql<string>`coalesce(sum(${usageEvents.costUsd}) filter (where ${standard}), 0)::numeric(18, 6)::text`,
      input: tokens(usageEvents.inputTokens),
      cached: tokens(usageEvents.cachedInputTokens),
      writes: tokens(usageEvents.cacheWriteInputTokens),
      writes1h: tokens(usageEvents.cacheWrite1hInputTokens),
      output: tokens(usageEvents.outputTokens),
      unpriced: sql<number>`count(*) filter (where ${usageEvents.pricingStatus} = 'unpriced')::int`,
      otherTiers: sql<number>`count(*) filter (where ${usageEvents.pricingStatus} = 'priced' and ${usageEvents.serviceTier} <> 'standard')::int`,
    })
    .from(usageEvents)
    .where(
      and(
        projectInOrganization(usageEvents.projectId, scope),
        projectId ? eq(usageEvents.projectId, projectId) : undefined,
        gte(usageEvents.occurredAt, period.from),
        lt(usageEvents.occurredAt, period.to),
      ),
    )
    .groupBy(usageEvents.provider, usageEvents.model);

  const micros = (usd: string) => {
    const [whole, fraction = ""] = usd.split(".");
    return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  };
  let unpriced = 0;
  let otherTiers = 0;
  const workloads: Workload[] = [];
  for (const row of rows) {
    unpriced += row.unpriced;
    otherTiers += row.otherTiers;
    if (BigInt(row.requests) === 0n) continue;
    workloads.push({
      provider: row.provider,
      model: row.model,
      requests: BigInt(row.requests),
      costMicros: micros(row.cost),
      parts: {
        input: BigInt(row.input),
        cached: BigInt(row.cached),
        writes: BigInt(row.writes),
        writes1h: BigInt(row.writes1h),
        output: BigInt(row.output),
      },
    });
  }
  return { workloads, unpriced, otherTiers };
}

/** Every model's standard-tier price in effect at `at`. */
export async function getCurrentPrices(
  db: Database,
  at: Date = new Date(),
): Promise<PriceOption[]> {
  const rows = await db
    .select()
    .from(modelPricing)
    .where(eq(modelPricing.serviceTier, "standard"));
  const byModel = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = `${row.provider}/${row.model}`;
    byModel.set(key, [...(byModel.get(key) ?? []), row]);
  }
  const options: PriceOption[] = [];
  for (const candidates of byModel.values()) {
    const found = selectEffectivePricing(candidates, at);
    if (found.found) {
      options.push({
        provider: found.row.provider,
        model: found.row.model,
        pricing: found.pricing,
      });
    }
  }
  return options;
}
