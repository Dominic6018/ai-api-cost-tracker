/**
 * The usage-based billing demo: an organization that bills its customers
 * for AI usage, run through one whole month. Everything is made with the
 * same functions the command line and dashboard use, in an organization
 * of its own, so it can be removed without touching anything else.
 */

import { asc, eq } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import {
  monthStart,
  parseSignedDecimal,
  type MonthlyCharges,
} from "@/lib/billing";
import { parseUsagePayload } from "@/lib/usage";
import { revenueReport, type RevenueReport } from "@/lib/revenue";
import type { AuditActor } from "../audit";
import { createBillingCustomer } from "../billing";
import { chargeMonth } from "../billing-charges";
import { applyCredits, grantCredit } from "../billing-credits";
import { changePlan, createBillingPlan } from "../billing-plans";
import { createPortalLink } from "../billing-portal";
import { createOrganization } from "../organizations";
import { getRevenueInputs } from "../revenue";
import {
  auditLog,
  billingCustomers,
  billingLedgerEntries,
  organizations,
  projects,
  usageEvents,
} from "../schema";
import { recordUsage } from "../usage";

/** The demo's own organization; nothing outside it is ever touched. */
export const BILLING_DEMO_SLUG = "demo-billing";

/** A plain Drizzle Postgres database, as the command line and tests use. */
type Database = Pick<
  PgDatabase<PgQueryResultHKT>,
  "transaction" | "select" | "insert" | "update"
>;

const PLANS = [
  {
    slug: "starter",
    name: "Starter",
    monthlyFeeMicros: 29_000_000n,
    includedUsageMicros: 10_000_000n,
    usageMultiplier: "1.5000",
  },
  {
    slug: "scale",
    name: "Scale",
    monthlyFeeMicros: 199_000_000n,
    includedUsageMicros: 150_000_000n,
    usageMultiplier: "1.2500",
  },
] as const;

/**
 * Each customer's plan and requests last month. Every request is 100,000
 * input and 80,000 output tokens of Claude Sonnet 5.5: $1.00 at the seed
 * prices.
 */
const CUSTOMERS = [
  {
    externalId: "cus_brightline",
    name: "Brightline",
    plan: "starter",
    requests: 12,
  },
  {
    externalId: "cus_harbor",
    name: "Harbor Labs",
    plan: "scale",
    requests: 160,
  },
  {
    externalId: "cus_quill",
    name: "Quill",
    plan: "starter",
    requests: 4,
    prepaidMicros: 20_000_000n,
  },
] as const;

export interface BillingDemoCustomer {
  externalId: string;
  name: string;
  plan: string;
  requests: number;
  aiCostMicros: bigint;
  charges: MonthlyCharges;
  creditAppliedMicros: bigint;
  /** What they owe now; negative when they're owed. */
  balanceMicros: bigint;
}

export interface BillingDemoResult {
  organizationId: string;
  /** The month billed, e.g. "2026-10-01". */
  month: string;
  customers: BillingDemoCustomer[];
  revenue: RevenueReport;
  /** A portal link for the first customer: the only copy of its token. */
  portal: { externalId: string; token: string };
}

/** Removes the demo organization and, by cascade, everything in it. */
export async function removeBillingDemo(
  db: Pick<Database, "transaction">,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [organization] = await tx
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.slug, BILLING_DEMO_SLUG));
    if (!organization) return false;
    // The audit log and projects first: both keep an organization from
    // being deleted. Deleting the project removes its usage; deleting the
    // organization then removes its billing data.
    await tx
      .delete(auditLog)
      .where(eq(auditLog.organizationId, organization.id));
    await tx
      .delete(projects)
      .where(eq(projects.organizationId, organization.id));
    await tx.delete(organizations).where(eq(organizations.id, organization.id));
    return true;
  });
}

/**
 * Bills last month from scratch: plans, customers and their subscriptions
 * from the start of the month, their AI usage during it, prepaid credit,
 * then the month's charges as of the first of this month, credit applied,
 * revenue against AI API cost, and a portal link. Usage is priced at
 * today's seed prices, as the demo data is, then dated last month.
 */
export async function runBillingDemo(
  db: Database,
  now: Date = new Date(),
): Promise<BillingDemoResult> {
  await removeBillingDemo(db);
  const thisMonth = monthStart(now);
  const month = monthStart(
    new Date(new Date(`${thisMonth}T00:00:00Z`).getTime() - 86_400_000),
  );
  const monthBegins = new Date(`${month}T00:00:00Z`);
  // The day the month is billed: the first of the next month.
  const billedAt = new Date(`${thisMonth}T01:00:00Z`);

  const created = await createOrganization(db, {
    name: "Demo Billing",
    slug: BILLING_DEMO_SLUG,
  });
  if (!created.ok) throw new Error("The demo organization already exists.");
  const organizationId = created.organization.id;
  const scope = { organizationId };
  const actor: AuditActor = {
    userId: null,
    label: "billing demo",
    organizationId,
  };
  const [project] = await db
    .insert(projects)
    .values({
      name: "Demo billing app",
      slug: "demo-billing-app",
      organizationId,
    })
    .returning({ id: projects.id });

  const plans = new Map<
    string,
    Awaited<ReturnType<typeof createBillingPlan>>
  >();
  for (const plan of PLANS) {
    plans.set(
      plan.slug,
      await createBillingPlan(db, actor, { ...scope, ...plan }),
    );
  }

  const customers: BillingDemoCustomer[] = [];
  for (const spec of CUSTOMERS) {
    const added = await createBillingCustomer(db, actor, {
      ...scope,
      externalId: spec.externalId,
      name: spec.name,
    });
    if (!added.ok) throw new Error(`Couldn't add ${spec.externalId}.`);
    const customer = added.customer;
    const plan = plans.get(spec.plan);
    if (!plan?.ok) throw new Error(`Couldn't add the ${spec.plan} plan.`);
    // Subscribed from the start of last month, as it was then.
    const subscribed = await changePlan(
      db,
      actor,
      customer,
      plan.plan,
      month,
      monthBegins,
    );
    if (!subscribed.ok) throw new Error(subscribed.error);
    if ("prepaidMicros" in spec) {
      const granted = await grantCredit(
        db,
        actor,
        customer,
        {
          amountMicros: spec.prepaidMicros,
          expiresAt: new Date(now.getTime() + 365 * 86_400_000),
          description: "Prepaid credit",
        },
        monthBegins,
      );
      if (!granted.ok) throw new Error(granted.error);
    }

    let aiCostMicros = 0n;
    for (let i = 0; i < spec.requests; i++) {
      const parsed = parseUsagePayload(
        {
          provider: "anthropic",
          model: "claude-sonnet-5-5",
          inputTokens: 100_000,
          outputTokens: 80_000,
          requestId: `demo-billing-${spec.externalId}-${i + 1}`,
          customerId: spec.externalId,
          feature: "assistant",
        },
        now,
      );
      if (!parsed.ok) throw new Error("Invalid demo usage.");
      const recorded = await recordUsage(db, {
        ...parsed.usage,
        projectId: project.id,
      });
      if (!recorded.ok || recorded.event.costUsd === null) {
        throw new Error(
          "Claude Sonnet 5.5 has no price. Run npm run db:seed first.",
        );
      }
      aiCostMicros += parseSignedDecimal(recorded.event.costUsd);
      // Spread across last month, one day apart, at noon.
      await db
        .update(usageEvents)
        .set({
          occurredAt: new Date(
            monthBegins.getTime() + ((i % 28) * 24 + 12) * 3_600_000,
          ),
        })
        .where(eq(usageEvents.id, recorded.event.id));
    }

    const charged = await chargeMonth(db, actor, customer, month, billedAt);
    if (!charged.ok)
      throw new Error(`Couldn't charge ${spec.externalId}: ${charged.error}`);
    const applied = await applyCredits(db, actor, customer, billedAt);
    const entries = await db
      .select({ amountUsd: billingLedgerEntries.amountUsd })
      .from(billingLedgerEntries)
      .where(eq(billingLedgerEntries.customerId, customer.id));
    customers.push({
      externalId: spec.externalId,
      name: spec.name,
      plan: spec.plan,
      requests: spec.requests,
      aiCostMicros,
      charges: charged.charges,
      creditAppliedMicros: applied.appliedMicros,
      balanceMicros: entries.reduce(
        (sum, e) => sum + parseSignedDecimal(e.amountUsd),
        0n,
      ),
    });
  }

  const revenue = revenueReport(await getRevenueInputs(db, scope, month));
  // A portal link for the first customer, to see their statement.
  const [first] = await db
    .select()
    .from(billingCustomers)
    .where(eq(billingCustomers.organizationId, organizationId))
    .orderBy(asc(billingCustomers.externalId))
    .limit(1);
  const { token } = await createPortalLink(db, {
    customer: first,
    createdBy: actor.label,
  });
  return {
    organizationId,
    month,
    customers,
    revenue,
    portal: { externalId: first.externalId, token },
  };
}
