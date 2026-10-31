import "dotenv/config";
import { parseArgs } from "node:util";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { parseEnv } from "@/lib/env";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "@/lib/passwords";
import { listUsers, resetPassword, revokeSessions } from "../accounts";
import { createUser } from "../auth";

const USAGE = `Usage:
  npm run user -- create --email <email> < password-file
  npm run user -- reset-password --email <email> < password-file
  npm run user -- revoke-sessions --email <email>
  npm run user -- list

create and reset-password read the password from standard input, so it
doesn't end up in shell history or the process list, e.g.
  echo "$PASSWORD" | npm run user -- create --email <email>
It must be ${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} characters. reset-password also signs the user out everywhere.`;

const COMMANDS = ["create", "reset-password", "revoke-sessions", "list"];

async function readPassword(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new Error("Pipe the password on standard input.\n\n" + USAGE);
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  // Drop the trailing newline that echo and most editors add.
  const password = Buffer.concat(chunks)
    .toString("utf8")
    .replace(/\r?\n$/, "");
  if (
    password.length < MIN_PASSWORD_LENGTH ||
    password.length > MAX_PASSWORD_LENGTH
  ) {
    throw new Error(
      `Password must be ${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} characters.`,
    );
  }
  return password;
}

const sessionCount = (n: number) => `${n} session${n === 1 ? "" : "s"}`;

// Manages dashboard accounts in the database in DATABASE_URL.
async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { email: { type: "string" } },
  });
  const [command] = positionals;
  if (!COMMANDS.includes(command) || (command !== "list" && !values.email)) {
    throw new Error(USAGE);
  }
  const email = values.email ?? "";
  // Validated before connecting, so a bad password never reaches the database.
  const password =
    command === "create" || command === "reset-password"
      ? await readPassword()
      : "";

  const client = postgres(parseEnv().DATABASE_URL, {
    max: 1,
    onnotice: () => {},
  });
  const db = drizzle(client);
  try {
    switch (command) {
      case "create": {
        const result = await createUser(db, { email, password });
        if (!result.ok)
          throw new Error("A user with that email already exists.");
        console.log(`Created user ${result.user.email}.`);
        break;
      }
      case "reset-password":
      case "revoke-sessions": {
        const result =
          command === "reset-password"
            ? await resetPassword(db, { email, password })
            : await revokeSessions(db, email);
        if (!result.ok) throw new Error("No user with that email.");
        const done =
          command === "reset-password"
            ? "Reset the password for"
            : "Signed out";
        console.log(
          `${done} ${result.email}; revoked ${sessionCount(result.revokedSessions)}.`,
        );
        break;
      }
      case "list": {
        const accounts = await listUsers(db);
        if (accounts.length === 0) console.log("No users yet.");
        for (const account of accounts) {
          console.log(
            `${account.email}  created ${account.createdAt.toISOString().slice(0, 10)}  ${sessionCount(account.activeSessions)} active`,
          );
        }
        break;
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
