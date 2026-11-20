import { createHash } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { AuditEntry } from "@/lib/audit";
import { customerDescription, parseSignedDecimal } from "@/lib/billing";
import { microsToCents, type StripeClient } from "@/lib/stripe";
import { audited, type AuditActor } from "./audit";
import {
  billingCustomers,
  billingLedgerEntries,
  billingStripeCustomers,
  billingStripeInvoiceItems,
  billingStripeInvoices,
  type BillingCustomer,
  type StripeInvoice,
} from "./schema";

type Database = Pick<
  PgDatabase<PgQueryResultHKT>,
  "select" | "insert" | "transaction"
>;
type Change<T> = { result: T; entry: AuditEntry | null };

/**
 * The customer's Stripe customer in this mode, created if there isn't
 * one. Saved straight away, so a later failure doesn't lose it; the
 * idempotency key makes a retry within a day return the same customer.
 */
export async function ensureStripeCustomer(
  db: Pick<Database, "select" | "insert">,
  client: StripeClient,
  customer: BillingCustomer,
): Promise<string> {
  const mine = and(
    eq(billingStripeCustomers.customerId, customer.id),
    eq(billingStripeCustomers.mode, client.mode),
  );
  const [known] = await db.select().from(billingStripeCustomers).where(mine);
  if (known) return known.stripeCustomerId;
  const created = await client.post<{ id: string }>(
    "/customers",
    {
      name: customer.name,
      metadata: {
        tracker_customer_id: customer.id,
        customer_id: customer.externalId,
      },
    },
    `tracker-customer-${client.mode}-${customer.id}`,
  );
  await db
    .insert(billingStripeCustomers)
    .values({
      customerId: customer.id,
      mode: client.mode,
      stripeCustomerId: created.id,
    })
    .onConflictDoNothing();
  // Another run may have saved one first; use whichever was saved.
  const [saved] = await db.select().from(billingStripeCustomers).where(mine);
  return saved.stripeCustomerId;
}

export type StripeInvoiceResult =
  | { ok: true; invoice: StripeInvoice; entries: number }
  | { ok: false; error: "nothing_to_invoice" }
  | { ok: false; error: "nothing_owed"; balanceCents: bigint };

/**
 * Creates a draft Stripe invoice for the customer's ledger entries not
 * yet invoiced in this mode: charges, credits, adjustments and reversals
 * alike, each as one item in whole cents. It stays a draft for you to
 * review and send in Stripe. Nothing is invoiced when the entries come
 * to zero or less.
 *
 * Every request carries an idempotency key derived from the entries, so
 * a run that fails partway can be repeated: Stripe returns the objects it
 * already created, and the entries are recorded only once it's all done.
 */
export async function invoiceOpenEntries(
  db: Pick<Database, "select" | "insert" | "transaction">,
  actor: AuditActor,
  client: StripeClient,
  customer: BillingCustomer,
): Promise<StripeInvoiceResult> {
  const stripeCustomerId = await ensureStripeCustomer(db, client, customer);
  return audited(
    db,
    actor,
    async (tx): Promise<Change<StripeInvoiceResult>> => {
      // One invoicing run per customer at a time.
      await tx
        .select({ id: billingCustomers.id })
        .from(billingCustomers)
        .where(eq(billingCustomers.id, customer.id))
        .for("update");
      const open = await tx
        .select({
          id: billingLedgerEntries.id,
          amountUsd: billingLedgerEntries.amountUsd,
          kind: billingLedgerEntries.kind,
          description: billingLedgerEntries.description,
          period: billingLedgerEntries.period,
        })
        .from(billingLedgerEntries)
        .where(
          and(
            eq(billingLedgerEntries.organizationId, customer.organizationId),
            eq(billingLedgerEntries.customerId, customer.id),
            sql`not exists (select 1 from ${billingStripeInvoiceItems} where ${billingStripeInvoiceItems.ledgerEntryId} = ${billingLedgerEntries.id} and ${billingStripeInvoiceItems.mode} = ${client.mode})`,
          ),
        )
        .orderBy(
          asc(billingLedgerEntries.createdAt),
          asc(billingLedgerEntries.id),
        );
      if (open.length === 0) {
        return {
          result: { ok: false, error: "nothing_to_invoice" },
          entry: null,
        };
      }
      const lines = open.map((e) => ({
        ...e,
        cents: microsToCents(parseSignedDecimal(e.amountUsd)),
      }));
      const totalCents = lines.reduce((sum, l) => sum + l.cents, 0n);
      if (totalCents <= 0n) {
        return {
          result: {
            ok: false,
            error: "nothing_owed",
            balanceCents: totalCents,
          },
          entry: null,
        };
      }

      // The same entries always give the same keys.
      const run = createHash("sha256")
        .update(
          `${client.mode}:${customer.id}:${lines.map((l) => l.id).join(",")}`,
        )
        .digest("hex")
        .slice(0, 32);
      const invoice = await client.post<{ id: string }>(
        "/invoices",
        {
          customer: stripeCustomerId,
          currency: "usd",
          collection_method: "send_invoice",
          days_until_due: 30,
          auto_advance: false,
          pending_invoice_items_behavior: "exclude",
          metadata: { tracker_customer_id: customer.id, entries: lines.length },
        },
        `tracker-invoice-${run}`,
      );
      const items: Array<{
        id: string;
        stripeItemId: string | null;
        cents: bigint;
      }> = [];
      for (const line of lines) {
        if (line.cents === 0n) {
          items.push({ id: line.id, stripeItemId: null, cents: 0n });
          continue;
        }
        const item = await client.post<{ id: string }>(
          "/invoiceitems",
          {
            customer: stripeCustomerId,
            invoice: invoice.id,
            currency: "usd",
            amount: line.cents.toString(),
            // The customer sees this: never a usage charge's cost.
            description: customerDescription(line),
            metadata: { ledger_entry_id: line.id },
          },
          `tracker-item-${run}-${line.id}`,
        );
        items.push({ id: line.id, stripeItemId: item.id, cents: line.cents });
      }

      const [stored] = await tx
        .insert(billingStripeInvoices)
        .values({
          organizationId: customer.organizationId,
          customerId: customer.id,
          mode: client.mode,
          stripeInvoiceId: invoice.id,
          amountCents: totalCents,
          createdBy: actor.label,
        })
        .returning();
      await tx.insert(billingStripeInvoiceItems).values(
        items.map((item) => ({
          ledgerEntryId: item.id,
          mode: client.mode,
          invoiceId: stored.id,
          stripeItemId: item.stripeItemId,
          amountCents: item.cents,
        })),
      );
      return {
        result: { ok: true, invoice: stored, entries: items.length },
        entry: {
          action: "billing.stripe_invoiced",
          target: customer.externalId,
          details: {
            stripeInvoiceId: invoice.id,
            mode: client.mode,
            amountCents: totalCents.toString(),
            entries: items.length,
          },
          organizationId: customer.organizationId,
        },
      };
    },
  );
}

/** Billing customers with ledger entries not yet invoiced in this mode. */
export async function customersWithOpenEntries(
  db: Pick<PgDatabase<PgQueryResultHKT>, "selectDistinct">,
  scope: { organizationId: string },
  mode: "test" | "live",
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
      billingLedgerEntries,
      eq(billingLedgerEntries.customerId, billingCustomers.id),
    )
    .where(
      and(
        eq(billingCustomers.organizationId, scope.organizationId),
        sql`not exists (select 1 from ${billingStripeInvoiceItems} where ${billingStripeInvoiceItems.ledgerEntryId} = ${billingLedgerEntries.id} and ${billingStripeInvoiceItems.mode} = ${mode})`,
      ),
    )
    .orderBy(asc(billingCustomers.externalId));
}
