import "dotenv/config";
import { parseArgs } from "node:util";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { parseEnv } from "@/lib/env";
import { demoBudgetStates, generateDemoData } from "../demo/generate";
import { loadDemoData, removeDemoData } from "../demo/load";

const USAGE = `Usage:
  npm run db:demo                     Load demo projects and 90 days of usage
  npm run db:demo -- --remove         Remove all demo data
Options:
  --seed <n>             Random seed (default 2026); the same seed and day give the same data
  --allow-production     Required to run when NODE_ENV is production, e.g. for a public demo`;

// Loads or removes demo data in the database in DATABASE_URL. Demo projects
// have slugs starting with "demo-", and only those are ever touched.
async function main() {
  const { values } = parseArgs({
    options: {
      remove: { type: "boolean", default: false },
      seed: { type: "string" },
      "allow-production": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }

  const env = parseEnv();
  if (env.NODE_ENV === "production" && !values["allow-production"]) {
    throw new Error(
      "Refusing to touch demo data: NODE_ENV is production. Pass --allow-production for a demo deployment.",
    );
  }
  const seed = values.seed === undefined ? undefined : Number(values.seed);
  if (seed !== undefined && !Number.isInteger(seed)) {
    throw new Error(`--seed must be an integer.\n\n${USAGE}`);
  }

  const client = postgres(env.DATABASE_URL, { max: 1, onnotice: () => {} });
  const db = drizzle(client);
  try {
    if (values.remove) {
      const removed = await removeDemoData(db);
      console.log(`Removed ${removed} demo project(s) and their usage.`);
      return;
    }
    const now = new Date();
    const data = generateDemoData({ now, seed });
    const loaded = await loadDemoData(db, data);
    const states = demoBudgetStates(data, now);
    console.log(
      `Loaded ${loaded.projects} demo project(s) and ${loaded.events} usage events.\n` +
        Object.entries(states)
          .map(([slug, state]) => `  ${slug}: budget ${state}`)
          .join("\n") +
        "\nDemo history is priced at today's seed prices. Remove it with: npm run db:demo -- --remove",
    );
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
