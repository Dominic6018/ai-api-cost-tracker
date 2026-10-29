import "dotenv/config";
import { parseArgs } from "node:util";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { parseEnv } from "@/lib/env";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "@/lib/passwords";
import { createUser } from "../auth";

const USAGE = `Usage:
  npm run user -- create --email <email> < password-file
  echo "$PASSWORD" | npm run user -- create --email <email>

The password is read from standard input so it doesn't end up in shell
history or the process list. It must be ${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} characters.`;

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new Error("Pipe the password on standard input.\n\n" + USAGE);
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  // Drop the trailing newline that echo and most editors add.
  return Buffer.concat(chunks)
    .toString("utf8")
    .replace(/\r?\n$/, "");
}

// Creates dashboard accounts in the database in DATABASE_URL.
async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { email: { type: "string" } },
  });
  if (positionals[0] !== "create" || !values.email) throw new Error(USAGE);

  const password = await readStdin();
  if (
    password.length < MIN_PASSWORD_LENGTH ||
    password.length > MAX_PASSWORD_LENGTH
  ) {
    throw new Error(
      `Password must be ${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} characters.`,
    );
  }

  const client = postgres(parseEnv().DATABASE_URL, {
    max: 1,
    onnotice: () => {},
  });
  try {
    const result = await createUser(drizzle(client), {
      email: values.email,
      password,
    });
    if (!result.ok) throw new Error(`A user with that email already exists.`);
    console.log(`Created user ${result.user.email}.`);
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
