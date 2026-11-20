import "dotenv/config";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { parseEnv } from "@/lib/env";
import type { InvoiceEvent, StripeEvent } from "@/lib/stripe-webhook";
import { COMMAND_LINE, type AuditActor } from "./audit";
import {
  addAdjustment,
  createBillingCustomer,
  listBillingCustomers,
} from "./billing";
import {
  auditLog,
  billingLedgerEntries,
  billingStripeInvoiceEvents,
  billingStripeInvoices,
  organizations,
} from "./schema";
import { listStripeInvoices, recordStripeEvent } from "./stripe-webhooks";

// Runs against the database in DATABASE_URL after `npm run db:migrate`.
const client = postgres(parseEnv().DATABASE_URL, {
  max: 1,
  onnotice: () => {},
});
const db = drizzle(client);

const organizationIds: string[] = [];

afterAll(async () => {
  if (organizationIds.length > 0) {
    await db
      .delete(auditLog)
      .where(inArray(auditLog.organizationId, organizationIds));
    await db
      .delete(organizations)
      .where(inArray(organizations.id, organizationIds));
  }
  await client.end();
});

async function setup() {
  const [organization] = await db
    .insert(organizations)
    .values({ name: "Webhook test", slug: `it-${randomUUID()}` })
    .returning();
  organizationIds.push(organization.id);
  const scope = { organizationId: organization.id };
  const actor: AuditActor = {
    ...COMMAND_LINE,
    organizationId: organization.id,
  };
  const created = await createBillingCustomer(db, actor, {
    ...scope,
    externalId: "cus_42",
    name: "Acme",
  });
  if (!created.ok) throw new Error("customer not created");
  const customer = created.customer;
  // What the customer owes: $64.00.
  await addAdjustment(db, actor, customer, {
    amountMicros: 64_000_000n,
    description: "Charges",
  });
  const invoice = async (mode: "test" | "live") => {
    const [row] = await db
      .insert(billingStripeInvoices)
      .values({
        organizationId: organization.id,
        customerId: customer.id,
        mode,
        stripeInvoiceId: `in_${randomUUID().slice(0, 12)}`,
        amountCents: 6400n,
        createdBy: "test",
      })
      .returning();
    return row;
  };
  const balance = async () =>
    (await listBillingCustomers(db, scope))[0].balanceMicros;
  return { organization, scope, customer, invoice, balance };
}

let seconds = 1_790_000_000;
function stripeEvent(
  stripeInvoiceId: string,
  type: string,
  options: { livemode?: boolean; paid?: bigint; currency?: string } = {},
): { event: StripeEvent; invoice: InvoiceEvent | null } {
  seconds += 60;
  const event: StripeEvent = {
    id: `evt_${randomUUID().slice(0, 12)}`,
    type,
    livemode: options.livemode ?? true,
    created: new Date(seconds * 1000),
  };
  const status = (
    {
      "invoice.finalized": "open",
      "invoice.paid": "paid",
      "invoice.payment_failed": "payment_failed",
      "invoice.voided": "void",
    } as const
  )[type as "invoice.paid"];
  return {
    event,
    invoice: status
      ? {
          ...event,
          status,
          stripeInvoiceId,
          amountPaidCents: status === "paid" ? (options.paid ?? 6400n) : null,
          currency: options.currency ?? "usd",
        }
      : null,
  };
}

const record = (e: ReturnType<typeof stripeEvent>) =>
  recordStripeEvent(db, e.event, e.invoice);

const payments = (customerId: string) =>
  db
    .select()
    .from(billingLedgerEntries)
    .where(
      and(
        eq(billingLedgerEntries.customerId, customerId),
        eq(billingLedgerEntries.kind, "payment"),
      ),
    );

describe("Stripe webhook events", () => {
  it("posts a live invoice's payment to the ledger, once", async () => {
    const t = await setup();
    const live = await t.invoice("live");
    const paid = stripeEvent(live.stripeInvoiceId, "invoice.paid");

    expect(await record(paid)).toEqual({
      outcome: "recorded",
      paymentPosted: true,
    });
    expect(await t.balance()).toBe(0n);
    const [payment] = await payments(t.customer.id);
    expect(payment).toMatchObject({
      amountUsd: "-64.000000",
      entryKey: `stripe:${live.stripeInvoiceId}:paid`,
      createdBy: "Stripe webhook",
    });

    // Stripe delivering the same event again changes nothing.
    expect(await record(paid)).toEqual({ outcome: "duplicate" });
    // Nor does another paid event for the invoice.
    expect(
      await record(stripeEvent(live.stripeInvoiceId, "invoice.paid")),
    ).toEqual({ outcome: "recorded", paymentPosted: false });
    expect(await payments(t.customer.id)).toHaveLength(1);

    const audited = await db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(eq(auditLog.organizationId, t.organization.id));
    expect(
      audited.filter((a) => a.action === "billing.stripe_paid"),
    ).toHaveLength(1);
  });

  it("records a sandbox payment's status without touching the ledger", async () => {
    const t = await setup();
    const test = await t.invoice("test");
    expect(
      await record(
        stripeEvent(test.stripeInvoiceId, "invoice.paid", { livemode: false }),
      ),
    ).toEqual({ outcome: "recorded", paymentPosted: false });
    expect(await payments(t.customer.id)).toEqual([]);
    expect(await t.balance()).toBe(64_000_000n);
    expect((await listStripeInvoices(db, t.customer))[0].status).toBe("paid");
  });

  it("ignores events for other invoices, other modes and other types", async () => {
    const t = await setup();
    const live = await t.invoice("live");
    for (const e of [
      stripeEvent("in_not_ours", "invoice.paid"),
      // A test-mode event can't touch a live invoice.
      stripeEvent(live.stripeInvoiceId, "invoice.paid", { livemode: false }),
      stripeEvent(live.stripeInvoiceId, "customer.created"),
    ]) {
      expect(await record(e)).toEqual({ outcome: "ignored" });
      expect(await record(e)).toEqual({ outcome: "duplicate" });
    }
    expect(await payments(t.customer.id)).toEqual([]);
    expect(
      await db
        .select()
        .from(billingStripeInvoiceEvents)
        .where(eq(billingStripeInvoiceEvents.invoiceId, live.id)),
    ).toEqual([]);
  });

  it("keeps each invoice's history, latest status last", async () => {
    const t = await setup();
    const live = await t.invoice("live");
    await record(stripeEvent(live.stripeInvoiceId, "invoice.finalized"));
    await record(stripeEvent(live.stripeInvoiceId, "invoice.payment_failed"));
    expect((await listStripeInvoices(db, t.customer))[0].status).toBe(
      "payment_failed",
    );
    // A payment in another currency is recorded, not posted.
    expect(
      await record(
        stripeEvent(live.stripeInvoiceId, "invoice.paid", { currency: "jpy" }),
      ),
    ).toEqual({ outcome: "recorded", paymentPosted: false });
    expect((await listStripeInvoices(db, t.customer))[0].status).toBe("paid");

    // The history can't be changed.
    await expect(
      db
        .update(billingStripeInvoiceEvents)
        .set({ status: "void" })
        .where(eq(billingStripeInvoiceEvents.invoiceId, live.id)),
    ).rejects.toThrow();
  });
});
