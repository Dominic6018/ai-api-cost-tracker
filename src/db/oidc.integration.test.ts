import "dotenv/config";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { parseEnv } from "@/lib/env";
import { createUser } from "./auth";
import { accountForSso } from "./oidc";
import { users } from "./schema";

// Runs against the database in DATABASE_URL after `npm run db:migrate`.
const client = postgres(parseEnv().DATABASE_URL, {
  max: 1,
  onnotice: () => {},
});
const db = drizzle(client);

const userIds: string[] = [];

afterAll(async () => {
  if (userIds.length > 0) {
    await db.delete(users).where(inArray(users.id, userIds));
  }
  await client.end();
});

async function newUser() {
  const result = await createUser(db, {
    email: `sso-${randomUUID()}@example.com`,
    password: "a long test password",
    role: "member",
  });
  if (!result.ok) throw new Error("expected a user");
  userIds.push(result.user.id);
  return result.user;
}

describe("accountForSso", () => {
  it("signs in an existing account and binds the subject", async () => {
    const user = await newUser();
    const subject = `sub-${randomUUID()}`;
    expect(
      await accountForSso(db, { email: user.email.toUpperCase(), subject }),
    ).toEqual(user);
    const [row] = await db.select().from(users).where(eq(users.id, user.id));
    expect(row.oidcSubject).toBe(subject);
    // The same subject signs in again.
    expect(await accountForSso(db, { email: user.email, subject })).toEqual(
      user,
    );
  });

  it("refuses another subject for a bound account", async () => {
    const user = await newUser();
    await accountForSso(db, {
      email: user.email,
      subject: `a-${randomUUID()}`,
    });
    expect(
      await accountForSso(db, {
        email: user.email,
        subject: `b-${randomUUID()}`,
      }),
    ).toBeNull();
  });

  it("refuses a subject already bound to another account", async () => {
    const first = await newUser();
    const second = await newUser();
    const subject = `shared-${randomUUID()}`;
    expect(await accountForSso(db, { email: first.email, subject })).toEqual(
      first,
    );
    expect(
      await accountForSso(db, { email: second.email, subject }),
    ).toBeNull();
    const [row] = await db.select().from(users).where(eq(users.id, second.id));
    expect(row.oidcSubject).toBeNull();
  });

  it("never creates an account", async () => {
    const email = `nobody-${randomUUID()}@example.com`;
    expect(
      await accountForSso(db, { email, subject: `sub-${randomUUID()}` }),
    ).toBeNull();
    expect(
      await db.select().from(users).where(eq(users.email, email)),
    ).toHaveLength(0);
  });
});
