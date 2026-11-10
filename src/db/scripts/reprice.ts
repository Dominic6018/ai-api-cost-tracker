import "dotenv/config";
import { parseArgs } from "node:util";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { parseEnv } from "@/lib/env";
import { COMMAND_LINE } from "../audit";
import { repriceUnpriced } from "../unpriced";

const USAGE = `Usage:
  npm run reprice [-- --dry-run]

Prices usage that was stored without a price, now that one has been added
(at /prices/new). Each event uses the price in effect when it occurred and
is priced once; running it again changes nothing. Events still missing a
price are listed by what's missing.

Options:
  --dry-run   Show what would be priced, without changing anything`;

// Prices unpriced usage in the database in DATABASE_URL.
async function main() {
  const { values } = parseArgs({
    options: {
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  const dryRun = values["dry-run"];
  const client = postgres(parseEnv().DATABASE_URL, {
    max: 1,
    onnotice: () => {},
  });
  try {
    const result = await repriceUnpriced(drizzle(client), COMMAND_LINE, {
      dryRun,
    });
    console.log(
      `${result.checked} unpriced event(s) checked; ${result.priced} ${dryRun ? "would be priced" : "priced"}.`,
    );
    for (const [reason, n] of Object.entries(result.stillUnpriced)) {
      console.log(`Still unpriced (${reason}): ${n}`);
    }
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
