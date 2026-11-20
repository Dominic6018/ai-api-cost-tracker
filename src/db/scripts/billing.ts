import "dotenv/config";
import { parseArgs } from "node:util";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import {
  formatEntryUsd,
  monthLabel,
  monthStart,
  parseBillingMonth,
  parseCreditExpiry,
  parseCustomerExternalId,
  parseCustomerName,
  parseEntryAmount,
  parseEntryDescription,
  parseEntryKey,
  parsePlanAmount,
  parsePlanName,
  parsePlanSlug,
  parseSignedDecimal,
  parseUsageMultiplier,
  type Parsed,
} from "@/lib/billing";
import { parseEnv } from "@/lib/env";
import { audited, COMMAND_LINE } from "../audit";
import {
  createPortalLink,
  listPortalLinks,
  revokePortalLink,
} from "../billing-portal";
import { portalLinkCreatedEntry, portalLinkRevokedEntry } from "@/lib/audit";
import { absoluteUrl } from "@/lib/links";
import { portalPath } from "@/lib/portal";
import {
  addAdjustment,
  createBillingCustomer,
  findBillingCustomer,
  listBillingCustomers,
  listLedgerEntries,
  reverseLedgerEntry,
} from "../billing";
import {
  changePlan,
  createBillingPlan,
  findBillingPlan,
  listBillingPlans,
  listSubscriptions,
  plansByCustomer,
} from "../billing-plans";
import { chargeMonth, customersOnPlans } from "../billing-charges";
import {
  applyCredits,
  grantCredit,
  listCreditGrants,
  refundCredit,
  usableCredit,
} from "../billing-credits";
import { findOrganization } from "../organizations";
import { getRevenueInputs } from "../revenue";
import {
  customersWithOpenEntries,
  invoiceOpenEntries,
} from "../billing-stripe";
import { listStripeInvoices } from "../stripe-webhooks";
import { createStripeClient, parseStripeConfig } from "@/lib/stripe";
import { formatShare, revenueReport } from "@/lib/revenue";

const USAGE = `Usage:
  npm run billing -- customer-add --customer <id> --name <name>
  npm run billing -- customers
  npm run billing -- adjust --customer <id> --amount <usd> --reason <text> [--key <key>]
  npm run billing -- reverse --entry <entry id> --reason <text>
  npm run billing -- ledger --customer <id>
  npm run billing -- plan-add --plan <slug> --name <name> --fee <usd> --included <usd> --multiplier <n> [--usage-limit <usd>]
  npm run billing -- plans
  npm run billing -- subscribe --customer <id> --plan <slug> [--from YYYY-MM]
  npm run billing -- unsubscribe --customer <id> [--from YYYY-MM]
  npm run billing -- charge [--month YYYY-MM] [--customer <id>]
  npm run billing -- grant-credit --customer <id> --amount <usd> --reason <text> [--expires YYYY-MM-DD] [--key <key>]
  npm run billing -- credits --customer <id>
  npm run billing -- apply-credits [--customer <id>]
  npm run billing -- refund-credit --grant <grant id> --reason <text>
  npm run billing -- revenue [--month YYYY-MM]
  npm run billing -- stripe-invoice [--customer <id>]
  npm run billing -- stripe-invoices --customer <id>
  npm run billing -- portal-link --customer <id> [--url <app URL>]
  npm run billing -- portal-links
  npm run billing -- portal-revoke --link <link id>

Each takes --org <slug>; the default organization otherwise.

The billing ledger records what customers are billed, apart from what the
providers charge. <id> is the customerId their usage is attributed to.
A positive amount is owed by the customer, a negative one is a credit
(write it as --amount=-5, since a value starting with "-" needs the "=").
Entries are never changed or deleted: reverse one to correct it. With
--key, repeating an adjustment returns the stored entry.

A plan has a monthly fee, the usage included in it (in USD of usage
charges), and the rate for usage as a multiple of its AI API cost
(--multiplier 1.25 is cost plus 25%). --usage-limit caps the AI API cost
a customer may use in a month, enforced by budget checks that name the
customer; without it there's no limit. Plans can't be changed; add a new
one. A customer's plan changes by UTC month, from the current month (the
default for --from) or a later one, replacing what was scheduled.

charge posts a finished month's plan fee and usage beyond the allowance
for every customer on a plan that month (or one --customer); --month
defaults to last month. A month is charged once, and not while any of its
usage is unpriced: price it first with npm run reprice. Credit is then
applied to what the customers owe.

Credit is prepaid: apply-credits uses it against what a customer owes,
soonest-expiring first. --expires is the last day it can be used (UTC).
refund-credit withdraws what's left of a grant.

revenue lists each customer's revenue (what the ledger billed for the
month), AI API cost and revenue minus AI API cost, which isn't profit;
--month defaults to this month.

stripe-invoice creates a draft Stripe invoice for each customer's ledger
entries not yet invoiced (or one --customer), for you to review and send
in Stripe. It needs STRIPE_SECRET_KEY, a test key unless
STRIPE_ALLOW_LIVE=true. stripe-invoices lists a customer's invoices with
their latest status from Stripe's webhooks.

portal-link makes a link that lets one customer read their own statement,
read-only and without an account, for 90 days; it's printed once. With
--url (e.g. https://costs.example.com) it prints the full address,
otherwise the path to add to yours. It never shows AI API cost.
portal-links lists the working links; portal-revoke stops one.`;

function valid<T>(parsed: Parsed<T>): T {
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

function parseAppUrl(value: string): URL {
  try {
    const url = new URL(value);
    if (url.protocol === "https:" || url.protocol === "http:") return url;
  } catch {
    // Reported below.
  }
  throw new Error(
    "--url must be the app's address, e.g. https://costs.example.com",
  );
}

// Manages the billing ledger in the database in DATABASE_URL.
async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      org: { type: "string", default: "default" },
      customer: { type: "string" },
      name: { type: "string" },
      amount: { type: "string" },
      reason: { type: "string" },
      key: { type: "string" },
      entry: { type: "string" },
      plan: { type: "string" },
      fee: { type: "string" },
      included: { type: "string" },
      multiplier: { type: "string" },
      "usage-limit": { type: "string" },
      from: { type: "string" },
      month: { type: "string" },
      expires: { type: "string" },
      grant: { type: "string" },
      link: { type: "string" },
      url: { type: "string" },
    },
  });
  const [command] = positionals;
  const required: Record<string, Array<keyof typeof values>> = {
    "customer-add": ["customer", "name"],
    customers: [],
    adjust: ["customer", "amount", "reason"],
    reverse: ["entry", "reason"],
    ledger: ["customer"],
    "plan-add": ["plan", "name", "fee", "included", "multiplier"],
    plans: [],
    subscribe: ["customer", "plan"],
    unsubscribe: ["customer"],
    charge: [],
    "grant-credit": ["customer", "amount", "reason"],
    credits: ["customer"],
    "apply-credits": [],
    "refund-credit": ["grant", "reason"],
    revenue: [],
    "stripe-invoice": [],
    "stripe-invoices": ["customer"],
    "portal-link": ["customer"],
    "portal-links": [],
    "portal-revoke": ["link"],
  };
  if (
    !command ||
    !(command in required) ||
    required[command].some((option) => values[option] === undefined)
  ) {
    throw new Error(USAGE);
  }
  // Validated before connecting.
  const customerId =
    values.customer !== undefined
      ? valid(parseCustomerExternalId(values.customer))
      : undefined;
  const name =
    values.name !== undefined
      ? valid(
          command === "plan-add"
            ? parsePlanName(values.name)
            : parseCustomerName(values.name),
        )
      : undefined;
  const planSlug =
    values.plan !== undefined ? valid(parsePlanSlug(values.plan)) : undefined;
  const fee =
    values.fee !== undefined
      ? valid(parsePlanAmount(values.fee, "The fee"))
      : undefined;
  const included =
    values.included !== undefined
      ? valid(parsePlanAmount(values.included, "The included usage"))
      : undefined;
  const usageLimit =
    values["usage-limit"] !== undefined
      ? valid(parsePlanAmount(values["usage-limit"], "The usage limit"))
      : null;
  const multiplier =
    values.multiplier !== undefined
      ? valid(parseUsageMultiplier(values.multiplier))
      : undefined;
  const thisMonth = monthStart(new Date());
  const month =
    values.month !== undefined
      ? valid(parseBillingMonth(values.month))
      : // Last month: the first of this month, a day earlier.
        monthStart(
          new Date(new Date(`${thisMonth}T00:00:00Z`).getTime() - 86_400_000),
        );
  const from =
    values.from !== undefined
      ? valid(parseBillingMonth(values.from))
      : thisMonth;
  const amount =
    values.amount !== undefined
      ? valid(parseEntryAmount(values.amount))
      : undefined;
  const reason =
    values.reason !== undefined
      ? valid(parseEntryDescription(values.reason))
      : undefined;
  const expires =
    values.expires !== undefined
      ? valid(parseCreditExpiry(values.expires))
      : null;
  if (command === "grant-credit" && amount !== undefined && amount <= 0n) {
    throw new Error("Credit is a positive amount.");
  }
  const key =
    values.key !== undefined ? valid(parseEntryKey(values.key)) : undefined;
  const appUrl = values.url !== undefined ? parseAppUrl(values.url) : null;

  // Stripe settings are checked before connecting, like the arguments.
  const stripe = command === "stripe-invoice" ? parseStripeConfig() : null;
  if (stripe && !stripe.enabled) throw new Error(stripe.reason);
  const stripeConfig = stripe?.enabled ? stripe : null;

  const client = postgres(parseEnv().DATABASE_URL, {
    max: 1,
    onnotice: () => {},
  });
  const db = drizzle(client);
  try {
    const organization = await findOrganization(db, values.org);
    if (!organization) throw new Error(`No organization "${values.org}".`);
    const scope = { organizationId: organization.id };
    const actor = { ...COMMAND_LINE, organizationId: organization.id };

    const customer = async () => {
      const found = await findBillingCustomer(db, scope, customerId!);
      if (!found) {
        throw new Error(
          `No billing customer "${customerId}" in ${organization.slug}; add one with customer-add.`,
        );
      }
      return found;
    };
    const plan = async () => {
      const found = await findBillingPlan(db, scope, planSlug!);
      if (!found) {
        throw new Error(
          `No plan "${planSlug}" in ${organization.slug}; add one with plan-add.`,
        );
      }
      return found;
    };
    const usd = (decimal: string) =>
      formatEntryUsd(parseSignedDecimal(decimal));

    if (command === "customer-add") {
      const result = await createBillingCustomer(db, actor, {
        ...scope,
        externalId: customerId!,
        name: name!,
      });
      if (!result.ok) {
        throw new Error(
          `Customer "${customerId}" is already in ${organization.slug}.`,
        );
      }
      console.log(`Added billing customer ${customerId} (${name}).`);
    } else if (command === "customers") {
      const plans = await plansByCustomer(db, scope, thisMonth);
      for (const row of await listBillingCustomers(db, scope)) {
        const current = plans.get(row.customer.id);
        console.log(
          `${row.customer.externalId}  ${row.customer.name}  balance ${formatEntryUsd(row.balanceMicros)}  ${row.entries} entr${row.entries === 1 ? "y" : "ies"}  plan ${current?.slug ?? "none"}`,
        );
      }
    } else if (command === "plan-add") {
      const result = await createBillingPlan(db, actor, {
        ...scope,
        slug: planSlug!,
        name: name!,
        monthlyFeeMicros: fee!,
        includedUsageMicros: included!,
        usageMultiplier: multiplier!,
        monthlyUsageLimitMicros: usageLimit,
      });
      if (!result.ok) {
        throw new Error(
          `Plan "${planSlug}" is already in ${organization.slug}.`,
        );
      }
      const added = result.plan;
      console.log(
        `Added plan ${added.slug} (${added.name}): ${usd(added.monthlyFeeUsd)} a month, ${usd(added.includedUsageUsd)} of usage included, usage at ${added.usageMultiplier} x AI API cost, ${added.monthlyUsageLimitUsd === null ? "no usage limit" : `usage limited to ${usd(added.monthlyUsageLimitUsd)} of AI API cost a month`}.`,
      );
    } else if (command === "plans") {
      for (const row of await listBillingPlans(db, scope, thisMonth)) {
        console.log(
          `${row.plan.slug}  ${row.plan.name}  fee ${usd(row.plan.monthlyFeeUsd)}  included ${usd(row.plan.includedUsageUsd)}  multiplier ${row.plan.usageMultiplier}  ${row.customers} customer(s) this month  limit ${row.plan.monthlyUsageLimitUsd === null ? "none" : usd(row.plan.monthlyUsageLimitUsd)}`,
        );
      }
    } else if (command === "charge") {
      const targets =
        customerId !== undefined
          ? [await customer()]
          : await customersOnPlans(db, scope, month);
      let blocked = 0;
      for (const target of targets) {
        const result = await chargeMonth(db, actor, target, month);
        const prefix = `${target.externalId}  ${monthLabel(month)}`;
        if (!result.ok) {
          if (result.error === "open_month") {
            throw new Error(
              `${monthLabel(month)} hasn't finished; months are charged once they're over.`,
            );
          }
          if (result.error === "unpriced_usage") {
            blocked += 1;
            console.log(
              `${prefix}  not charged: ${result.unpriced} request(s) have no price yet; add the price and run npm run reprice`,
            );
          } else {
            console.log(`${prefix}  no plan; nothing to charge`);
          }
          continue;
        }
        const { charges } = result;
        console.log(
          `${prefix}  ${result.planSlug}: fee ${formatEntryUsd(charges.feeMicros)}, usage ${formatEntryUsd(charges.billableUsageMicros)} (AI API cost ${formatEntryUsd(result.usage.costMicros)}, ${result.usage.requests} request(s))  ${result.posted ? "posted" : result.entries.length > 0 ? "already charged" : "nothing to post"}`,
        );
        const credit = await applyCredits(db, actor, target);
        if (credit.appliedMicros > 0n) {
          console.log(
            `${prefix}  credit applied ${formatEntryUsd(credit.appliedMicros)}`,
          );
        }
      }
      if (targets.length === 0) {
        console.log(`No customers on a plan in ${monthLabel(month)}.`);
      }
      if (blocked > 0) {
        throw new Error(
          `${blocked} customer(s) not charged because of unpriced usage.`,
        );
      }
    } else if (command === "grant-credit") {
      const result = await grantCredit(db, actor, await customer(), {
        amountMicros: amount!,
        expiresAt: expires,
        description: reason!,
        grantKey: key,
      });
      if (!result.ok) {
        throw new Error(
          result.error === "already_expired"
            ? "That expiry date has passed."
            : `Grant key "${key}" was already used for a different grant.`,
        );
      }
      const { grant } = result;
      console.log(
        `${result.replayed ? "Already granted" : "Granted"} ${usd(grant.amountUsd)} of credit to ${customerId}${grant.expiresAt ? `, usable until ${grant.expiresAt.toISOString()}` : ""}: grant ${grant.id}`,
      );
    } else if (command === "credits") {
      const found = await customer();
      const grants = await listCreditGrants(db, found);
      console.log(
        `${found.externalId}  usable credit ${formatEntryUsd(usableCredit(grants))}`,
      );
      for (const g of grants) {
        console.log(
          [
            g.grant.id,
            `granted ${usd(g.grant.amountUsd)}`,
            `used ${formatEntryUsd(g.usedMicros)}`,
            `left ${formatEntryUsd(g.remainingMicros)}`,
            g.grant.expiresAt
              ? `${g.expired ? "expired" : "expires"} ${g.grant.expiresAt.toISOString()}`
              : "no expiry",
            g.grant.description,
          ].join("  "),
        );
      }
    } else if (command === "apply-credits") {
      const targets =
        customerId !== undefined
          ? [await customer()]
          : (await listBillingCustomers(db, scope))
              .filter((row) => row.balanceMicros > 0n)
              .map((row) => row.customer);
      for (const target of targets) {
        const result = await applyCredits(db, actor, target);
        console.log(
          `${target.externalId}  credit applied ${formatEntryUsd(result.appliedMicros)}`,
        );
      }
    } else if (command === "refund-credit") {
      const result = await refundCredit(db, actor, scope, {
        grantId: values.grant!,
        reason: reason!,
      });
      if (!result.ok) {
        throw new Error(
          {
            not_found: `No credit grant ${values.grant} in ${organization.slug}.`,
            expired: "That credit has expired; there's nothing to refund.",
            nothing_left: "That credit has all been used or refunded.",
          }[result.error],
        );
      }
      console.log(
        `Refunded ${formatEntryUsd(result.refundedMicros)} of unused credit from grant ${values.grant} (${result.customerExternalId}).`,
      );
    } else if (command === "revenue") {
      const reportMonth = values.month !== undefined ? month : thisMonth;
      const report = revenueReport(
        await getRevenueInputs(db, scope, reportMonth),
      );
      const line = (
        label: string,
        r: {
          revenueMicros: bigint;
          costMicros: bigint;
          differenceMicros: bigint;
          sharePermille: number | null;
          unpriced: number;
        },
      ) =>
        `${label}  revenue ${formatEntryUsd(r.revenueMicros)}  AI API cost ${formatEntryUsd(r.costMicros)}  revenue minus AI API cost ${formatEntryUsd(r.differenceMicros)} (${formatShare(r.sharePermille)} of revenue)${r.unpriced > 0 ? `  ${r.unpriced} unpriced request(s)` : ""}`;
      console.log(
        `${monthLabel(reportMonth)}${reportMonth >= thisMonth ? " (so far)" : ""}`,
      );
      for (const row of report.rows) {
        console.log(line(row.customerId ?? "(no customer)", row));
      }
      console.log(line("Total", report.total));
    } else if (command === "stripe-invoice") {
      const client = createStripeClient(stripeConfig!);
      const targets =
        customerId !== undefined
          ? [await customer()]
          : await customersWithOpenEntries(db, scope, client.mode);
      if (targets.length === 0) {
        console.log("Nothing to invoice: every ledger entry is on an invoice.");
      }
      const cents = (n: bigint) =>
        `${n < 0n ? "-" : ""}$${(n < 0n ? -n : n) / 100n}.${String((n < 0n ? -n : n) % 100n).padStart(2, "0")}`;
      for (const target of targets) {
        const result = await invoiceOpenEntries(db, actor, client, target);
        if (result.ok) {
          console.log(
            `${target.externalId}  draft invoice ${result.invoice.stripeInvoiceId} for ${cents(result.invoice.amountCents)} (${result.entries} entr${result.entries === 1 ? "y" : "ies"}, ${client.mode} mode)`,
          );
        } else if (result.error === "nothing_owed") {
          console.log(
            `${target.externalId}  not invoiced: the open entries come to ${cents(result.balanceCents)}, so nothing is owed`,
          );
        } else {
          console.log(`${target.externalId}  nothing to invoice`);
        }
      }
    } else if (command === "portal-link") {
      const found = await customer();
      const { token, link } = await audited(db, actor, async (tx) => {
        const created = await createPortalLink(tx, {
          customer: found,
          createdBy: actor.label,
        });
        return { result: created, entry: portalLinkCreatedEntry(created.link) };
      });
      const path = portalPath(token);
      console.log(
        `Portal link for ${found.externalId}, working until ${link.expiresAt.toISOString().slice(0, 10)}. ` +
          "Send it only to the customer; it can't be shown again:\n\n" +
          (appUrl
            ? absoluteUrl(path, {
                host: appUrl.host,
                proto: appUrl.protocol.replace(":", ""),
              })
            : path),
      );
    } else if (command === "portal-links") {
      const links = await listPortalLinks(db, organization.id);
      if (links.length === 0) console.log("No working portal links.");
      for (const link of links) {
        console.log(
          [
            link.id,
            link.customer.externalId,
            `until ${link.expiresAt.toISOString().slice(0, 10)}`,
            link.lastViewedAt
              ? `opened ${link.lastViewedAt.toISOString().slice(0, 10)}`
              : "never opened",
            link.createdBy,
          ].join("  "),
        );
      }
    } else if (command === "portal-revoke") {
      const revoked = await audited(db, actor, async (tx) => {
        const done = await revokePortalLink(tx, {
          organizationId: organization.id,
          linkId: values.link!,
        });
        return {
          result: done,
          entry: done ? portalLinkRevokedEntry(done) : null,
        };
      });
      if (!revoked) {
        throw new Error(
          `No working portal link "${values.link}" in ${organization.slug}.`,
        );
      }
      console.log(
        `Revoked the portal link for ${revoked.customer.externalId}.`,
      );
    } else if (command === "stripe-invoices") {
      const found = await customer();
      const invoices = await listStripeInvoices(db, found);
      if (invoices.length === 0) {
        console.log(`${found.externalId}  no Stripe invoices`);
      }
      for (const { invoice, status } of invoices) {
        const cents = invoice.amountCents;
        console.log(
          [
            invoice.createdAt.toISOString().slice(0, 10),
            invoice.stripeInvoiceId,
            `$${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`,
            invoice.mode,
            status ?? "draft (no events yet)",
          ].join("  "),
        );
      }
    } else if (command === "subscribe" || command === "unsubscribe") {
      const target = await customer();
      const chosen = command === "subscribe" ? await plan() : null;
      const result = await changePlan(db, actor, target, chosen, from);
      if (!result.ok) {
        throw new Error(
          result.error === "past_month"
            ? `Plans change from the current month (${monthLabel(thisMonth)}) or later, so billed months stay as they were.`
            : chosen
              ? `${customerId} is already on ${chosen.slug} from ${monthLabel(from)}.`
              : `${customerId} has no plan from ${monthLabel(from)}.`,
        );
      }
      const replaced =
        result.replaced > 0
          ? ` (replaced ${result.replaced} scheduled change(s))`
          : "";
      console.log(
        `${customerId}: ${chosen ? `on ${chosen.slug}` : "no plan"} from ${monthLabel(from)}${replaced}.`,
      );
    } else if (command === "adjust") {
      const result = await addAdjustment(db, actor, await customer(), {
        amountMicros: amount!,
        description: reason!,
        entryKey: key,
      });
      if (!result.ok) {
        throw new Error(
          `Entry key "${key}" was already used for a different adjustment.`,
        );
      }
      console.log(
        `${result.replayed ? "Already recorded" : "Recorded"} ${formatEntryUsd(parseSignedDecimal(result.entry.amountUsd))} for ${customerId}: entry ${result.entry.id}`,
      );
    } else if (command === "reverse") {
      const result = await reverseLedgerEntry(db, actor, scope, {
        entryId: values.entry!,
        description: reason!,
      });
      if (!result.ok) {
        throw new Error(
          {
            not_found: `No ledger entry ${values.entry} in ${organization.slug}.`,
            is_reversal: "That entry is a reversal; it can't be reversed.",
            is_credit:
              "Applied credit can't be reversed; grant new credit instead.",
            already_reversed: "That entry has already been reversed.",
          }[result.error],
        );
      }
      console.log(
        `Reversed entry ${values.entry} with ${formatEntryUsd(parseSignedDecimal(result.entry.amountUsd))}: entry ${result.entry.id}`,
      );
    } else {
      const found = await customer();
      const balance = (await listBillingCustomers(db, scope)).find(
        (row) => row.customer.id === found.id,
      );
      console.log(
        `${found.externalId}  ${found.name}  balance ${formatEntryUsd(balance?.balanceMicros ?? 0n)}`,
      );
      for (const row of await listSubscriptions(db, found)) {
        const { startsOn, endsOn } = row.subscription;
        console.log(
          `plan ${row.plan.slug} from ${monthLabel(startsOn)}${endsOn ? ` until ${monthLabel(endsOn)}` : ""}`,
        );
      }
      for (const entry of await listLedgerEntries(db, found)) {
        console.log(
          [
            entry.createdAt.toISOString(),
            entry.kind.padEnd(10),
            formatEntryUsd(parseSignedDecimal(entry.amountUsd)).padStart(18),
            entry.id,
            entry.reversesEntryId ? `reverses ${entry.reversesEntryId}` : "",
            entry.description,
          ]
            .filter(Boolean)
            .join("  "),
        );
      }
    }
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
