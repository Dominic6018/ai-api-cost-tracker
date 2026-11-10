import "dotenv/config";
import { parseArgs } from "node:util";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { parseEnv } from "@/lib/env";
import { createApiKey, revokeApiKey } from "../api-keys";
import { audited, COMMAND_LINE } from "../audit";
import { API_KEY_SCOPES, type ApiKeyScope } from "../schema";

const USAGE = `Usage:
  npm run api-key -- create --project <slug> --name <label> [--scope ingest|read] [--org <slug>]
  npm run api-key -- revoke <key prefix>

--scope ingest (the default) creates a key that sends usage, outcomes and
traces. --scope read creates a key for the reporting API, which can't
send anything; give read keys only to tools that need cost data.`;

// Manages API keys in the database in DATABASE_URL.
async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      project: { type: "string" },
      name: { type: "string" },
      scope: { type: "string" },
      org: { type: "string" },
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
      const scope = values.scope ?? "ingest";
      if (!(API_KEY_SCOPES as readonly string[]).includes(scope)) {
        throw new Error(`--scope must be ingest or read.\n\n${USAGE}`);
      }
      const { project, name } = values;
      const result = await audited(db, COMMAND_LINE, async (tx) => {
        const created = await createApiKey(tx, {
          projectSlug: project,
          organizationSlug: values.org,
          name,
          scope: scope as ApiKeyScope,
        });
        return {
          result: created,
          // The prefix identifies the key; the key itself is never stored.
          entry: created.ok
            ? {
                action: "api_key.created" as const,
                target: created.record.keyPrefix,
                organizationId: created.organizationId,
                details: { project, name, scope },
              }
            : null,
        };
      });
      if (!result.ok) {
        throw new Error(
          result.error === "project_ambiguous"
            ? `More than one organization has a project "${values.project}"; add --org <slug>.`
            : `No project with slug "${values.project}"${values.org ? ` in organization "${values.org}"` : ""}`,
        );
      }
      console.log(
        `Created ${scope} API key "${values.name}" for project "${values.project}" ` +
          `(prefix ${result.record.keyPrefix}).\n` +
          "Store it now; it can't be shown again:\n\n" +
          result.key,
      );
    } else if (command === "revoke" && argument) {
      const revoked = await audited(db, COMMAND_LINE, async (tx) => {
        const done = await revokeApiKey(tx, argument);
        return {
          result: done,
          entry: done
            ? {
                action: "api_key.revoked" as const,
                target: argument,
                organizationId: done.organizationId,
              }
            : null,
        };
      });
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
