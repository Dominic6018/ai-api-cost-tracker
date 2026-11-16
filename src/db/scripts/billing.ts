import "dotenv/config";
import { parseArgs } from "node:util";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import {
  formatEntryUsd,
  monthLabel,
  monthStart,
  parseBillingMonth,
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
import { COMMAND_LINE } from "../audit";
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
import { findOrganization } from "../organizations";

const USAGE = `Usage:
  npm run billing -- customer-add --customer <id> --name <name>
  npm run billing -- customers
  npm run billing -- adjust --customer <id> --amount <usd> --reason <text> [--key <key>]
  npm run billing -- reverse --entry <entry id> --reason <text>
  npm run billing -- ledger --customer <id>
  npm run billing -- plan-add --plan <slug> --name <name> --fee <usd> --included <usd> --multiplier <n>
  npm run billing -- plans
  npm run billing -- subscribe --customer <id> --plan <slug> [--from YYYY-MM]
  npm run billing -- unsubscribe --customer <id> [--from YYYY-MM]
  npm run billing -- charge [--month YYYY-MM] [--customer <id>]

Each takes --org <slug>; the default organization otherwise.

The billing ledger records what customers are billed, apart from what the
providers charge. <id> is the customerId their usage is attributed to.
A positive amount is owed by the customer, a negative one is a credit
(write it as --amount=-5, since a value starting with "-" needs the "=").
Entries are never changed or deleted: reverse one to correct it. With
--key, repeating an adjustment returns the stored entry.

A plan has a monthly fee, the usage included in it (in USD of usage
charges), and the rate for usage as a multiple of its AI API cost
(--multiplier 1.25 is cost plus 25%). Plans can't be changed; add a new
one. A customer's plan changes by UTC month, from the current month (the
default for --from) or a later one, replacing what was scheduled.

charge posts a finished month's plan fee and usage beyond the allowance
for every customer on a plan that month (or one --customer); --month
defaults to last month. A month is charged once, and not while any of its
usage is unpriced: price it first with npm run reprice.`;

function valid<T>(parsed: Parsed<T>): T {
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
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
      from: { type: "string" },
      month: { type: "string" },
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
  const key =
    values.key !== undefined ? valid(parseEntryKey(values.key)) : undefined;

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
      });
      if (!result.ok) {
        throw new Error(
          `Plan "${planSlug}" is already in ${organization.slug}.`,
        );
      }
      const added = result.plan;
      console.log(
        `Added plan ${added.slug} (${added.name}): ${usd(added.monthlyFeeUsd)} a month, ${usd(added.includedUsageUsd)} of usage included, usage at ${added.usageMultiplier} x AI API cost.`,
      );
    } else if (command === "plans") {
      for (const row of await listBillingPlans(db, scope, thisMonth)) {
        console.log(
          `${row.plan.slug}  ${row.plan.name}  fee ${usd(row.plan.monthlyFeeUsd)}  included ${usd(row.plan.includedUsageUsd)}  multiplier ${row.plan.usageMultiplier}  ${row.customers} customer(s) this month`,
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
      }
      if (targets.length === 0) {
        console.log(`No customers on a plan in ${monthLabel(month)}.`);
      }
      if (blocked > 0) {
        throw new Error(
          `${blocked} customer(s) not charged because of unpriced usage.`,
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
