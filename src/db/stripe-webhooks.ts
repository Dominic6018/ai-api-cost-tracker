import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { TablesRelationalConfig } from "drizzle-orm/relations";
import type { AuditEntry } from "@/lib/audit";
import { microsToDecimal } from "@/lib/budget";
import type { InvoiceEvent, StripeEvent } from "@/lib/stripe-webhook";
import { audited, type AuditActor } from "./audit";
import {
  billingLedgerEntries,
  billingStripeInvoiceEvents,
  billingStripeInvoices,
  stripeWebhookEvents,
  type BillingCustomer,
  type StripeInvoice,
} from "./schema";

type Database = Pick<
  PgDatabase<PgQueryResultHKT>,
  "select" | "insert" | "transaction"
>;
type Change<T> = { result: T; entry: AuditEntry | null };

export type WebhookOutcome =
  | { outcome: "duplicate" }
  | { outcome: "ignored" }
  | { outcome: "recorded"; paymentPosted: boolean };

/**
 * Records a verified Stripe event once. An invoice event for an invoice
 * the tracker created, in the same mode, adds to that invoice's history;
 * a live invoice's payment also goes on the ledger as a `payment` entry,
 * reducing what the customer owes. Anything else is acknowledged and
 * ignored. A test-mode payment never changes the ledger, as test-mode
 * invoicing doesn't either.
 */
export function recordStripeEvent<
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
>(
  // Generic, so both the app's schema-aware database and plain ones fit.
  db: Pick<PgDatabase<TQueryResult, TFullSchema, TSchema>, "transaction">,
  event: StripeEvent,
  invoiceEvent: InvoiceEvent | null,
): Promise<WebhookOutcome> {
  return db.transaction(async (tx) => {
    let invoice: StripeInvoice | undefined;
    if (invoiceEvent) {
      [invoice] = await tx
        .select()
        .from(billingStripeInvoices)
        .where(
          eq(
            billingStripeInvoices.stripeInvoiceId,
            invoiceEvent.stripeInvoiceId,
          ),
        );
    }
    // Only the tracker's own invoices, from the mode they were made in.
    const ours =
      invoice !== undefined &&
      invoiceEvent !== null &&
      (invoice.mode === "live") === event.livemode;

    const [received] = await tx
      .insert(stripeWebhookEvents)
      .values({
        eventId: event.id,
        type: event.type,
        livemode: event.livemode,
        outcome: ours ? "recorded" : "ignored",
      })
      .onConflictDoNothing()
      .returning();
    if (!received) return { outcome: "duplicate" } as const;
    if (!ours || !invoice || !invoiceEvent) {
      return { outcome: "ignored" } as const;
    }

    await tx.insert(billingStripeInvoiceEvents).values({
      invoiceId: invoice.id,
      stripeEventId: event.id,
      status: invoiceEvent.status,
      amountPaidCents: invoiceEvent.amountPaidCents,
      occurredAt: event.created,
    });

    const cents = invoiceEvent.amountPaidCents ?? 0n;
    const postPayment =
      invoiceEvent.status === "paid" &&
      invoice.mode === "live" &&
      cents > 0n &&
      invoiceEvent.currency === "usd";
    if (!postPayment) {
      return { outcome: "recorded", paymentPosted: false } as const;
    }
    const actor: AuditActor = {
      userId: null,
      label: "Stripe webhook",
      organizationId: invoice.organizationId,
    };
    const stripeInvoice = invoice;
    // Within this transaction: the payment and its audit entry together.
    const posted = await audited(
      tx,
      actor,
      async (inner): Promise<Change<boolean>> => {
        const [entry] = await inner
          .insert(billingLedgerEntries)
          .values({
            organizationId: stripeInvoice.organizationId,
            customerId: stripeInvoice.customerId,
            kind: "payment",
            amountUsd: microsToDecimal(-cents * 10_000n),
            description: `Paid in Stripe, invoice ${stripeInvoice.stripeInvoiceId}`,
            // One payment per invoice, whatever Stripe sends again.
            entryKey: `stripe:${stripeInvoice.stripeInvoiceId}:paid`,
            createdBy: actor.label,
          })
          .onConflictDoNothing()
          .returning();
        return entry
          ? {
              result: true,
              entry: {
                action: "billing.stripe_paid",
                target: stripeInvoice.stripeInvoiceId,
                details: {
                  entryId: entry.id,
                  amountUsd: entry.amountUsd,
                  stripeEventId: event.id,
                },
                organizationId: stripeInvoice.organizationId,
              },
            }
          : { result: false, entry: null };
      },
    );
    return { outcome: "recorded", paymentPosted: posted } as const;
  });
}

export interface InvoiceWithStatus {
  invoice: StripeInvoice;
  /** The latest status from Stripe; null before any event arrived. */
  status: string | null;
}

/** A customer's Stripe invoices, newest first, with their latest status. */
export async function listStripeInvoices(
  db: Pick<Database, "select">,
  customer: Pick<BillingCustomer, "id" | "organizationId">,
): Promise<InvoiceWithStatus[]> {
  // Drizzle writes columns of a single-table select without their table,
  // which inside this subquery would mean the event's own id; name the
  // invoice's id in full.
  const invoiceId = sql.raw(`"billing_stripe_invoices"."id"`);
  const latest = sql<
    string | null
  >`(select ${billingStripeInvoiceEvents.status} from ${billingStripeInvoiceEvents} where ${billingStripeInvoiceEvents.invoiceId} = ${invoiceId} order by ${billingStripeInvoiceEvents.occurredAt} desc, ${billingStripeInvoiceEvents.receivedAt} desc limit 1)`;
  const rows = await db
    .select({ invoice: billingStripeInvoices, status: latest })
    .from(billingStripeInvoices)
    .where(
      and(
        eq(billingStripeInvoices.organizationId, customer.organizationId),
        eq(billingStripeInvoices.customerId, customer.id),
      ),
    )
    .orderBy(
      desc(billingStripeInvoices.createdAt),
      asc(billingStripeInvoices.id),
    );
  return rows;
}
