import {
  and,
  asc,
  eq,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { AuditEntry } from "@/lib/audit";
import {
  chargedEntry,
  monthLabel,
  monthStart,
  monthlyCharges,
  nextMonth,
  parseSignedDecimal,
  type MonthlyCharges,
} from "@/lib/billing";
import { microsToDecimal } from "@/lib/budget";
import { audited, type AuditActor } from "./audit";
import { planForMonth } from "./billing-plans";
import {
  billingCustomers,
  billingLedgerEntries,
  billingSubscriptions,
  projects,
  usageEvents,
  type BillingCustomer,
  type BillingLedgerEntry,
} from "./schema";

type Database = Pick<
  PgDatabase<PgQueryResultHKT>,
  "select" | "insert" | "transaction"
>;
type Change<T> = { result: T; entry: AuditEntry | null };

export interface MonthUsage {
  /** The AI API cost of the customer's priced usage in the month. */
  costMicros: bigint;
  requests: number;
  /** Requests still waiting for a price, which would make the cost short. */
  unpriced: number;
}

/**
 * A customer's usage in the UTC month starting `month`: their
 * `customerId` across every project in the customer's organization.
 */
export async function usageForMonth(
  db: Pick<Database, "select">,
  customer: Pick<BillingCustomer, "externalId" | "organizationId">,
  month: string,
): Promise<MonthUsage> {
  const [row] = await db
    .select({
      cost: sql<string>`coalesce(sum(${usageEvents.costUsd}), 0)::text`,
      requests: sql<number>`count(*)::int`,
      unpriced: sql<number>`count(*) filter (where ${usageEvents.pricingStatus} = 'unpriced')::int`,
    })
    .from(usageEvents)
    .innerJoin(projects, eq(projects.id, usageEvents.projectId))
    .where(
      and(
        eq(projects.organizationId, customer.organizationId),
        eq(usageEvents.customerId, customer.externalId),
        gte(usageEvents.occurredAt, new Date(`${month}T00:00:00Z`)),
        lt(usageEvents.occurredAt, new Date(`${nextMonth(month)}T00:00:00Z`)),
      ),
    );
  return {
    costMicros: parseSignedDecimal(row.cost),
    requests: row.requests,
    unpriced: row.unpriced,
  };
}

export type ChargeResult =
  | {
      ok: true;
      /** False when the month had already been charged; nothing new. */
      posted: boolean;
      planSlug: string;
      usage: MonthUsage;
      charges: MonthlyCharges;
      entries: BillingLedgerEntry[];
    }
  | { ok: false; error: "open_month" | "no_plan" }
  | { ok: false; error: "unpriced_usage"; unpriced: number };

const CHARGE_KINDS = ["plan_fee", "usage_charge"] as const;

/**
 * Posts a customer's charges for a finished UTC month on the plan they
 * were on: the monthly fee, and usage beyond the allowance at the plan's
 * multiplier. A month is charged once: once it has either entry, running
 * again returns them. Refused while any of the month's usage is unpriced,
 * so a customer is never billed on a cost that's short.
 */
export function chargeMonth(
  db: Pick<Database, "transaction">,
  actor: AuditActor,
  customer: BillingCustomer,
  month: string,
  now: Date = new Date(),
): Promise<ChargeResult> {
  return audited(db, actor, async (tx): Promise<Change<ChargeResult>> => {
    if (month >= monthStart(now)) {
      return { result: { ok: false, error: "open_month" }, entry: null };
    }
    // One charge run per customer at a time.
    await tx
      .select({ id: billingCustomers.id })
      .from(billingCustomers)
      .where(eq(billingCustomers.id, customer.id))
      .for("update");

    const on = await planForMonth(tx, customer, month);
    if (!on) return { result: { ok: false, error: "no_plan" }, entry: null };
    const usage = await usageForMonth(tx, customer, month);
    if (usage.unpriced > 0) {
      return {
        result: {
          ok: false,
          error: "unpriced_usage",
          unpriced: usage.unpriced,
        },
        entry: null,
      };
    }
    const charges = monthlyCharges(on.plan, usage.costMicros);

    const existing = await tx
      .select()
      .from(billingLedgerEntries)
      .where(
        and(
          eq(billingLedgerEntries.organizationId, customer.organizationId),
          eq(billingLedgerEntries.customerId, customer.id),
          eq(billingLedgerEntries.period, month),
          inArray(billingLedgerEntries.kind, [...CHARGE_KINDS]),
        ),
      )
      .orderBy(asc(billingLedgerEntries.kind));
    if (existing.length > 0) {
      return {
        result: {
          ok: true,
          posted: false,
          planSlug: on.plan.slug,
          usage,
          charges,
          entries: existing,
        },
        entry: null,
      };
    }

    const label = monthLabel(month);
    const common = {
      organizationId: customer.organizationId,
      customerId: customer.id,
      period: month,
      planId: on.plan.id,
      createdBy: actor.label,
    };
    const values = [];
    if (charges.feeMicros > 0n) {
      values.push({
        ...common,
        kind: "plan_fee" as const,
        amountUsd: microsToDecimal(charges.feeMicros),
        description: `${on.plan.name} plan, ${label}`,
      });
    }
    if (charges.billableUsageMicros > 0n) {
      values.push({
        ...common,
        kind: "usage_charge" as const,
        amountUsd: microsToDecimal(charges.billableUsageMicros),
        usageCostUsd: microsToDecimal(usage.costMicros),
        description: `Usage, ${label}: $${microsToDecimal(usage.costMicros)} AI API cost x ${on.plan.usageMultiplier} = $${microsToDecimal(charges.usageChargeMicros)}, less $${microsToDecimal(charges.includedMicros)} included`,
      });
    }
    const entries =
      values.length > 0
        ? await tx.insert(billingLedgerEntries).values(values).returning()
        : [];
    const amount = (kind: (typeof CHARGE_KINDS)[number]) =>
      entries.find((e) => e.kind === kind)?.amountUsd ?? null;
    return {
      result: {
        ok: true,
        posted: entries.length > 0,
        planSlug: on.plan.slug,
        usage,
        charges,
        entries,
      },
      entry:
        entries.length > 0
          ? chargedEntry({
              customerExternalId: customer.externalId,
              period: month,
              planSlug: on.plan.slug,
              feeUsd: amount("plan_fee"),
              usageUsd: amount("usage_charge"),
              usageCostUsd: microsToDecimal(usage.costMicros),
              organizationId: customer.organizationId,
            })
          : null,
    };
  });
}

/** Customers on a plan in the month, to charge them all. */
export function customersOnPlans(
  db: Pick<PgDatabase<PgQueryResultHKT>, "selectDistinct">,
  scope: { organizationId: string },
  month: string,
): Promise<BillingCustomer[]> {
  return db
    .selectDistinct({
      id: billingCustomers.id,
      organizationId: billingCustomers.organizationId,
      externalId: billingCustomers.externalId,
      name: billingCustomers.name,
      createdAt: billingCustomers.createdAt,
    })
    .from(billingCustomers)
    .innerJoin(
      billingSubscriptions,
      eq(billingSubscriptions.customerId, billingCustomers.id),
    )
    .where(
      and(
        eq(billingCustomers.organizationId, scope.organizationId),
        lte(billingSubscriptions.startsOn, month),
        or(
          isNull(billingSubscriptions.endsOn),
          sql`${billingSubscriptions.endsOn} > ${month}`,
        ),
      ),
    )
    .orderBy(asc(billingCustomers.externalId));
}
