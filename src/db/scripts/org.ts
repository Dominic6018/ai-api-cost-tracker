import "dotenv/config";
import { parseArgs } from "node:util";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { parseEnv } from "@/lib/env";
import { projectFormSchema } from "@/lib/projects";
import { audited, COMMAND_LINE } from "../audit";
import { createOrganization, listOrganizations } from "../organizations";

const USAGE = `Usage:
  npm run org -- create --name <name> --slug <slug>
  npm run org -- list

Each organization sees only its own projects, usage and audit log. Put
accounts in one with: npm run user -- create --org <slug>, or set-org.
Admins of the default organization are the install's owners: only they
can change prices, which every organization shares.`;

const organizationFields = projectFormSchema.pick({ name: true, slug: true });

// Manages organizations in the database in DATABASE_URL.
async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { name: { type: "string" }, slug: { type: "string" } },
  });
  const [command] = positionals;
  if (!(
    command === "list" ||
    (command === "create" && values.name && values.slug)
  )) {
    throw new Error(USAGE);
  }
  // Validated before connecting.
  const fields =
    command === "create"
      ? organizationFields.safeParse({ name: values.name, slug: values.slug })
      : undefined;
  if (fields && !fields.success) {
    throw new Error(fields.error.issues.map((i) => i.message).join("\n"));
  }

  const client = postgres(parseEnv().DATABASE_URL, {
    max: 1,
    onnotice: () => {},
  });
  const db = drizzle(client);
  try {
    if (fields?.success) {
      const result = await audited(db, COMMAND_LINE, async (tx) => {
        const created = await createOrganization(tx, fields.data);
        return {
          result: created,
          entry: created.ok
            ? {
                action: "organization.created" as const,
                target: created.organization.slug,
                details: { name: created.organization.name },
              }
            : null,
        };
      });
      if (!result.ok) {
        throw new Error("An organization with that slug already exists.");
      }
      console.log(
        `Created organization ${result.organization.name} (${result.organization.slug}).`,
      );
    } else {
      for (const org of await listOrganizations(db)) {
        console.log(
          `${org.slug}  ${org.name}  ${org.accounts} account(s)  ${org.projects} project(s)`,
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
