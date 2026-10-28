import "dotenv/config";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { parseEnv } from "@/lib/env";
import { seedPrices } from "./data";
import { seed } from "./seed";

// Entry point for `npm run db:seed`. Only runs when invoked explicitly.
async function main() {
  const env = parseEnv();
  if (env.NODE_ENV === "production") {
    throw new Error("Refusing to seed: NODE_ENV is production.");
  }

  const client = postgres(env.DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    const result = await seed(drizzle(client));
    console.log(
      `Seeded ${result.projectsInserted} project(s) and ` +
        `${result.pricesInserted} of ${seedPrices.length} price(s); ` +
        "existing rows were left unchanged.",
    );
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
