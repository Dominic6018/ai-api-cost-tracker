import "dotenv/config";
import { parseArgs } from "node:util";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import {
  formatEntryUsd,
  parseCustomerExternalId,
  parseCustomerName,
  parseEntryAmount,
  parseEntryDescription,
  parseEntryKey,
  parseSignedDecimal,
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
import { findOrganization } from "../organizations";

const USAGE = `Usage:
  npm run billing -- customer-add --customer <id> --name <name>
  npm run billing -- customers
  npm run billing -- adjust --customer <id> --amount <usd> --reason <text> [--key <key>]
  npm run billing -- reverse --entry <entry id> --reason <text>
  npm run billing -- ledger --customer <id>

Each takes --org <slug>; the default organization otherwise.

The billing ledger records what customers are billed, apart from what the
providers charge. <id> is the customerId their usage is attributed to.
A positive amount is owed by the customer, a negative one is a credit
(write it as --amount=-5, since a value starting with "-" needs the "=").
Entries are never changed or deleted: reverse one to correct it. With
--key, repeating an adjustment returns the stored entry.`;

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
    },
  });
  const [command] = positionals;
  const required: Record<string, Array<keyof typeof values>> = {
    "customer-add": ["customer", "name"],
    customers: [],
    adjust: ["customer", "amount", "reason"],
    reverse: ["entry", "reason"],
    ledger: ["customer"],
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
      ? valid(parseCustomerName(values.name))
      : undefined;
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
      for (const row of await listBillingCustomers(db, scope)) {
        console.log(
          `${row.customer.externalId}  ${row.customer.name}  balance ${formatEntryUsd(row.balanceMicros)}  ${row.entries} entr${row.entries === 1 ? "y" : "ies"}`,
        );
      }
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
