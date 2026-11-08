import "dotenv/config";
import { parseArgs } from "node:util";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { parseEnv } from "@/lib/env";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "@/lib/passwords";
import {
  listUsers,
  resetPassword,
  revokeSessions,
  setUserRole,
} from "../accounts";
import { audited, COMMAND_LINE } from "../audit";
import { createUser } from "../auth";
import { USER_ROLES, type UserRole } from "../schema";

const USAGE = `Usage:
  npm run user -- create --email <email> [--role <role>] < password-file
  npm run user -- reset-password --email <email> < password-file
  npm run user -- revoke-sessions --email <email>
  npm run user -- set-role --email <email> --role <role>
  npm run user -- list

create and reset-password read the password from standard input, so it
doesn't end up in shell history or the process list, e.g.
  echo "$PASSWORD" | npm run user -- create --email <email>
It must be ${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} characters. reset-password also signs the user out everywhere.

Roles: admin (the default; can change everything), member (can manage
projects, not prices), viewer (read-only). A new role applies straight away.`;

const COMMANDS = [
  "create",
  "reset-password",
  "revoke-sessions",
  "set-role",
  "list",
];

const isRole = (value: string): value is UserRole =>
  (USER_ROLES as readonly string[]).includes(value);

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
    options: { email: { type: "string" }, role: { type: "string" } },
  });
  const [command] = positionals;
  if (!COMMANDS.includes(command) || (command !== "list" && !values.email)) {
    throw new Error(USAGE);
  }
  const email = values.email ?? "";
  if (command === "set-role" && !values.role) throw new Error(USAGE);
  if (values.role !== undefined && !isRole(values.role)) {
    throw new Error(`Role must be one of: ${USER_ROLES.join(", ")}.`);
  }
  const role = values.role as UserRole | undefined;
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
        const result = await audited(db, COMMAND_LINE, async (tx) => {
          const created = await createUser(tx, { email, password, role });
          return {
            result: created,
            entry: created.ok
              ? {
                  action: "account.created" as const,
                  target: created.user.email,
                  details: { role: created.user.role },
                }
              : null,
          };
        });
        if (!result.ok)
          throw new Error("A user with that email already exists.");
        console.log(`Created user ${result.user.email} (${result.user.role}).`);
        break;
      }
      case "set-role": {
        const result = await audited(db, COMMAND_LINE, async (tx) => {
          const changed = await setUserRole(tx, {
            email,
            role: role as UserRole,
          });
          return {
            result: changed,
            entry:
              changed.ok && changed.previousRole !== changed.role
                ? {
                    action: "account.role_changed" as const,
                    target: changed.email,
                    details: {
                      role: { from: changed.previousRole, to: changed.role },
                    },
                  }
                : null,
          };
        });
        if (!result.ok) throw new Error("No user with that email.");
        console.log(`${result.email} is now ${result.role}.`);
        break;
      }
      case "reset-password":
      case "revoke-sessions": {
        const result = await audited(db, COMMAND_LINE, async (tx) => {
          const done =
            command === "reset-password"
              ? await resetPassword(tx, { email, password })
              : await revokeSessions(tx, email);
          return {
            result: done,
            entry: done.ok
              ? {
                  action:
                    command === "reset-password"
                      ? ("account.password_reset" as const)
                      : ("account.sessions_revoked" as const),
                  target: done.email,
                  details: { revokedSessions: done.revokedSessions },
                }
              : null,
          };
        });
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
            `${account.email}  ${account.role}  created ${account.createdAt.toISOString().slice(0, 10)}  ${sessionCount(account.activeSessions)} active`,
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
