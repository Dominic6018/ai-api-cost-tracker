import { and, eq, gte, inArray, lt, ne, or, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { nextMonth, parseSignedDecimal } from "@/lib/billing";
import type { RevenueInput } from "@/lib/revenue";
import {
  billingCustomers,
  billingLedgerEntries,
  projects,
  usageEvents,
} from "./schema";

type Database = Pick<PgDatabase<PgQueryResultHKT>, "select">;

/**
 * Each customer's revenue and AI API cost in the UTC month starting
 * `month`, for one organization.
 *
 * Revenue is what the ledger billed for the month: its plan fees and
 * usage charges, and adjustments and reversals made during it. Applied
 * credit is how a bill was paid, not less revenue, so it's left out.
 * Cost is the customer's usage that month across the organization's
 * projects, with usage attributed to no customer as its own row.
 * Customers with neither are left out.
 */
export async function getRevenueInputs(
  db: Database,
  scope: { organizationId: string },
  month: string,
): Promise<RevenueInput[]> {
  const from = new Date(`${month}T00:00:00Z`);
  const to = new Date(`${nextMonth(month)}T00:00:00Z`);

  const billed = await db
    .select({
      customerId: billingCustomers.externalId,
      revenue: sql<string>`sum(${billingLedgerEntries.amountUsd})::text`,
    })
    .from(billingLedgerEntries)
    .innerJoin(
      billingCustomers,
      eq(billingCustomers.id, billingLedgerEntries.customerId),
    )
    .where(
      and(
        eq(billingLedgerEntries.organizationId, scope.organizationId),
        ne(billingLedgerEntries.kind, "credit_applied"),
        or(
          and(
            inArray(billingLedgerEntries.kind, ["plan_fee", "usage_charge"]),
            eq(billingLedgerEntries.period, month),
          ),
          and(
            inArray(billingLedgerEntries.kind, ["adjustment", "reversal"]),
            gte(billingLedgerEntries.createdAt, from),
            lt(billingLedgerEntries.createdAt, to),
          ),
        ),
      ),
    )
    .groupBy(billingCustomers.externalId);

  const used = await db
    .select({
      customerId: usageEvents.customerId,
      cost: sql<string>`coalesce(sum(${usageEvents.costUsd}), 0)::text`,
      unpriced: sql<number>`count(*) filter (where ${usageEvents.pricingStatus} = 'unpriced')::int`,
    })
    .from(usageEvents)
    .innerJoin(projects, eq(projects.id, usageEvents.projectId))
    .where(
      and(
        eq(projects.organizationId, scope.organizationId),
        gte(usageEvents.occurredAt, from),
        lt(usageEvents.occurredAt, to),
      ),
    )
    .groupBy(usageEvents.customerId);

  const names = new Map(
    (
      await db
        .select({
          customerId: billingCustomers.externalId,
          name: billingCustomers.name,
        })
        .from(billingCustomers)
        .where(eq(billingCustomers.organizationId, scope.organizationId))
    ).map((c) => [c.customerId, c.name]),
  );

  const rows = new Map<string | null, RevenueInput>();
  const entry = (customerId: string | null) => {
    let found = rows.get(customerId);
    if (!found) {
      found = {
        customerId,
        name: customerId === null ? null : (names.get(customerId) ?? null),
        revenueMicros: 0n,
        costMicros: 0n,
        unpriced: 0,
      };
      rows.set(customerId, found);
    }
    return found;
  };
  for (const b of billed) {
    entry(b.customerId).revenueMicros = parseSignedDecimal(b.revenue);
  }
  for (const u of used) {
    const row = entry(u.customerId);
    row.costMicros = parseSignedDecimal(u.cost);
    row.unpriced = u.unpriced;
  }
  return [...rows.values()];
}
