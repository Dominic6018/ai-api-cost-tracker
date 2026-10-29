import "dotenv/config";
import { parseArgs } from "node:util";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { parseEnv } from "@/lib/env";
import { createApiKey, revokeApiKey } from "../api-keys";

const USAGE = `Usage:
  npm run api-key -- create --project <slug> --name <label>
  npm run api-key -- revoke <key prefix>`;

// Manages ingestion API keys in the database in DATABASE_URL.
async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      project: { type: "string" },
      name: { type: "string" },
    },
  });
  const [command, argument] = positionals;

  const client = postgres(parseEnv().DATABASE_URL, {
    max: 1,
    onnotice: () => {},
  });
  const db = drizzle(client);
  try {
    if (command === "create" && values.project && values.name) {
      const result = await createApiKey(db, {
        projectSlug: values.project,
        name: values.name,
      });
      if (!result.ok)
        throw new Error(`No project with slug "${values.project}"`);
      console.log(
        `Created API key "${values.name}" for project "${values.project}" ` +
          `(prefix ${result.record.keyPrefix}).\n` +
          "Store it now; it can't be shown again:\n\n" +
          result.key,
      );
    } else if (command === "revoke" && argument) {
      const revoked = await revokeApiKey(db, argument);
      if (!revoked)
        throw new Error(`No active API key with prefix "${argument}"`);
      console.log(`Revoked API key ${argument}.`);
    } else {
      throw new Error(USAGE);
    }
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
