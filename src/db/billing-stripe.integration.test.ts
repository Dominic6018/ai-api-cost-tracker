import "dotenv/config";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { parseEnv } from "@/lib/env";
import type { StripeClient } from "@/lib/stripe";
import { COMMAND_LINE, type AuditActor } from "./audit";
import { addAdjustment, createBillingCustomer } from "./billing";
import { createBillingPlan } from "./billing-plans";
import { customersWithOpenEntries, invoiceOpenEntries } from "./billing-stripe";
import {
  auditLog,
  billingLedgerEntries,
  billingStripeCustomers,
  billingStripeInvoiceItems,
  billingStripeInvoices,
  organizations,
} from "./schema";

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

/**
 * Stripe, in memory: like the real API, a repeated idempotency key
 * returns the object it first created. `failOn` makes one call throw once.
 */
function fakeStripe(mode: "test" | "live" = "test") {
  const byKey = new Map<string, { id: string }>();
  const calls: Array<{
    path: string;
    params: Record<string, unknown>;
    key: string;
  }> = [];
  let failOn: ((call: { path: string; n: number }) => boolean) | null = null;
  let n = 0;
  const stripe: StripeClient & {
    calls: typeof calls;
    failOnce(rule: (call: { path: string; n: number }) => boolean): void;
  } = {
    mode,
    calls,
    failOnce(rule) {
      failOn = rule;
    },
    async post<T extends { id: string }>(
      path: string,
      params: Record<string, unknown>,
      key: string,
    ): Promise<T> {
      n += 1;
      calls.push({ path, params, key });
      if (failOn?.({ path, n })) {
        failOn = null;
        throw new Error("Stripe is down");
      }
      const known = byKey.get(key);
      if (known) return known as T;
      const prefix =
        { "/customers": "cus", "/invoices": "in", "/invoiceitems": "ii" }[
          path
        ] ?? "obj";
      const created = { id: `${prefix}_${randomUUID().slice(0, 8)}` };
      byKey.set(key, created);
      return created as T;
    },
  };
  return stripe;
}

async function setup() {
  const [organization] = await db
    .insert(organizations)
    .values({ name: "Stripe test", slug: `it-${randomUUID()}` })
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
  const entry = (amountMicros: bigint, description = "Charge") =>
    addAdjustment(db, actor, customer, { amountMicros, description });
  return { organization, scope, actor, customer, entry };
}

const invoices = (customerId: string) =>
  db
    .select()
    .from(billingStripeInvoices)
    .where(eq(billingStripeInvoices.customerId, customerId));

describe("invoicing the ledger in Stripe", () => {
  it("invoices each open entry once, as a draft in whole cents", async () => {
    const t = await setup();
    const stripe = fakeStripe();
    await t.entry(49_000_000n, "Pro plan, 2026-10");
    await t.entry(17_500_001n, "Usage, 2026-10");
    await t.entry(-2_500_000n, "Goodwill credit");

    const result = await invoiceOpenEntries(db, t.actor, stripe, t.customer);
    expect(result).toMatchObject({
      ok: true,
      entries: 3,
      invoice: { amountCents: 6400n, mode: "test" },
    });
    // One customer, one draft invoice sent manually, three items.
    expect(stripe.calls.map((c) => c.path)).toEqual([
      "/customers",
      "/invoices",
      "/invoiceitems",
      "/invoiceitems",
      "/invoiceitems",
    ]);
    expect(stripe.calls[1].params).toMatchObject({
      currency: "usd",
      collection_method: "send_invoice",
      auto_advance: false,
      pending_invoice_items_behavior: "exclude",
    });
    expect(stripe.calls.slice(2).map((c) => c.params.amount)).toEqual([
      "4900",
      "1750",
      "-250",
    ]);

    // Running again finds nothing new.
    expect(await invoiceOpenEntries(db, t.actor, stripe, t.customer)).toEqual({
      ok: false,
      error: "nothing_to_invoice",
    });
    // A later entry goes on its own invoice, reusing the Stripe customer.
    await t.entry(10_000_000n, "Setup");
    const next = await invoiceOpenEntries(db, t.actor, stripe, t.customer);
    expect(next).toMatchObject({
      ok: true,
      entries: 1,
      invoice: { amountCents: 1000n },
    });
    expect(stripe.calls.filter((c) => c.path === "/customers")).toHaveLength(1);
    expect(await invoices(t.customer.id)).toHaveLength(2);

    const audited = await db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(eq(auditLog.organizationId, t.organization.id));
    expect(
      audited.filter((a) => a.action === "billing.stripe_invoiced"),
    ).toHaveLength(2);
  });

  it("never shows the customer a usage charge's AI API cost", async () => {
    const t = await setup();
    const stripe = fakeStripe();
    const plan = await createBillingPlan(db, t.actor, {
      ...t.scope,
      slug: "pro",
      name: "Pro",
      monthlyFeeMicros: 49_000_000n,
      includedUsageMicros: 20_500_000n,
      usageMultiplier: "1.2500",
    });
    if (!plan.ok) throw new Error("plan not created");
    // A usage charge as charge writes it: its description is for staff.
    await db.insert(billingLedgerEntries).values({
      ...t.scope,
      customerId: t.customer.id,
      kind: "usage_charge",
      amountUsd: "17.000000",
      usageCostUsd: "30.000000",
      planId: plan.plan.id,
      period: "2026-10-01",
      description:
        "Usage, 2026-10: $30.000000 AI API cost x 1.25 = $37.500000, less $20.500000 included",
      createdBy: "command line",
    });
    await t.entry(5_000_000n, "Setup, as agreed");

    const result = await invoiceOpenEntries(db, t.actor, stripe, t.customer);
    expect(result).toMatchObject({ ok: true, entries: 2 });
    const items = stripe.calls.filter((c) => c.path === "/invoiceitems");
    expect(items.map((c) => [c.params.description, c.params.amount])).toEqual([
      ["Usage, 2026-10", "1700"],
      ["Setup, as agreed", "500"],
    ]);
    // Nothing sent to Stripe names the cost or the multiplier.
    expect(JSON.stringify(stripe.calls)).not.toMatch(
      /AI API cost|30\.000000|1\.25/,
    );
  });

  it("invoices nothing when the open entries come to zero or less", async () => {
    const t = await setup();
    const stripe = fakeStripe();
    await t.entry(5_000_000n);
    await t.entry(-8_000_000n);
    expect(await invoiceOpenEntries(db, t.actor, stripe, t.customer)).toEqual({
      ok: false,
      error: "nothing_owed",
      balanceCents: -300n,
    });
    expect(stripe.calls.map((c) => c.path)).toEqual(["/customers"]);
    expect(await invoices(t.customer.id)).toEqual([]);
  });

  it("can be retried after a failure, without a second invoice", async () => {
    const t = await setup();
    const stripe = fakeStripe();
    await t.entry(1_000_000n);
    await t.entry(2_000_000n);
    // The second item fails: nothing is recorded.
    stripe.failOnce(({ path, n }) => path === "/invoiceitems" && n === 4);
    await expect(
      invoiceOpenEntries(db, t.actor, stripe, t.customer),
    ).rejects.toThrow("Stripe is down");
    expect(await invoices(t.customer.id)).toEqual([]);

    const firstKeys = stripe.calls.map((c) => c.key);
    const retry = await invoiceOpenEntries(db, t.actor, stripe, t.customer);
    expect(retry).toMatchObject({ ok: true, entries: 2 });
    // The retry sent the same keys, so Stripe returned the same invoice.
    const retryKeys = stripe.calls.slice(firstKeys.length).map((c) => c.key);
    // The Stripe customer was saved, so only the invoice and items repeat.
    expect(retryKeys).toEqual(firstKeys.slice(1));
    const ids = new Set(
      stripe.calls.filter((c) => c.path === "/invoices").map((c) => c.key),
    );
    expect(ids.size).toBe(1);
    expect(await invoices(t.customer.id)).toHaveLength(1);
  });

  it("records an entry that rounds to $0.00 without a Stripe item", async () => {
    const t = await setup();
    const stripe = fakeStripe();
    await t.entry(3_000_000n);
    await t.entry(4_000n, "Rounding");
    const result = await invoiceOpenEntries(db, t.actor, stripe, t.customer);
    if (!result.ok) throw new Error(result.error);
    expect(stripe.calls.filter((c) => c.path === "/invoiceitems")).toHaveLength(
      1,
    );
    const items = await db
      .select()
      .from(billingStripeInvoiceItems)
      .where(eq(billingStripeInvoiceItems.invoiceId, result.invoice.id));
    expect(
      items.map((i) => [i.amountCents, i.stripeItemId === null]).sort(),
    ).toEqual([
      [0n, true],
      [300n, false],
    ]);
  });

  it("keeps test and live invoicing apart", async () => {
    const t = await setup();
    await t.entry(1_000_000n);
    await invoiceOpenEntries(db, t.actor, fakeStripe("test"), t.customer);
    // Invoiced in the sandbox, still open for live.
    expect(
      (await customersWithOpenEntries(db, t.scope, "test")).map((c) => c.id),
    ).toEqual([]);
    expect(
      (await customersWithOpenEntries(db, t.scope, "live")).map((c) => c.id),
    ).toEqual([t.customer.id]);
    const live = await invoiceOpenEntries(
      db,
      t.actor,
      fakeStripe("live"),
      t.customer,
    );
    expect(live).toMatchObject({ ok: true, invoice: { mode: "live" } });
    const mapped = await db
      .select({ mode: billingStripeCustomers.mode })
      .from(billingStripeCustomers)
      .where(eq(billingStripeCustomers.customerId, t.customer.id));
    expect(mapped.map((m) => m.mode).sort()).toEqual(["live", "test"]);
    // Another organization's customers aren't listed.
    const other = await setup();
    await other.entry(1_000_000n);
    expect(
      (await customersWithOpenEntries(db, t.scope, "live")).map((c) => c.id),
    ).toEqual([]);
  });

  it("keeps what was sent: invoices and items are append-only", async () => {
    const t = await setup();
    await t.entry(1_000_000n);
    const result = await invoiceOpenEntries(
      db,
      t.actor,
      fakeStripe(),
      t.customer,
    );
    if (!result.ok) throw new Error(result.error);
    await expect(
      db
        .update(billingStripeInvoices)
        .set({ amountCents: 1n })
        .where(eq(billingStripeInvoices.id, result.invoice.id)),
    ).rejects.toThrow();
    await expect(
      db
        .delete(billingStripeInvoiceItems)
        .where(eq(billingStripeInvoiceItems.invoiceId, result.invoice.id)),
    ).rejects.toThrow();
  });
});
