import "dotenv/config";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { parseEnv } from "@/lib/env";
import { hashSessionToken, SESSION_TTL_MS } from "@/lib/sessions";
import {
  createSession,
  createUser,
  deleteExpiredSessions,
  deleteSession,
  getSessionUser,
  verifyCredentials,
} from "./auth";
import { sessions, users } from "./schema";

// Runs against the database in DATABASE_URL after `npm run db:migrate`.
const client = postgres(parseEnv().DATABASE_URL, {
  max: 1,
  onnotice: () => {},
});
const db = drizzle(client);

const createdUserIds: string[] = [];
const password = "a long test password";

afterAll(async () => {
  // Deleting users cascades to their sessions.
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await client.end();
});

async function newUser(email = `it-${randomUUID()}@example.com`) {
  const result = await createUser(db, { email, password });
  if (!result.ok) throw new Error("expected user creation to succeed");
  createdUserIds.push(result.user.id);
  return result.user;
}

describe("users", () => {
  it("stores a lowercased email and only a password hash", async () => {
    const email = `IT-${randomUUID()}@Example.COM`;
    const user = await newUser(email);
    expect(user.email).toBe(email.toLowerCase());

    const [stored] = await db.select().from(users).where(eq(users.id, user.id));
    expect(stored.passwordHash).toMatch(/^scrypt\$/);
    expect(stored.passwordHash).not.toContain(password);
  });

  it("rejects a duplicate email regardless of case", async () => {
    const user = await newUser();
    expect(
      await createUser(db, { email: user.email.toUpperCase(), password }),
    ).toEqual({ ok: false, error: "email_taken" });
  });

  it("verifies credentials case-insensitively by email", async () => {
    const user = await newUser();
    expect(
      await verifyCredentials(db, {
        email: ` ${user.email.toUpperCase()} `,
        password,
      }),
    ).toEqual(user);
  });

  it("rejects a wrong password and an unknown email the same way", async () => {
    const user = await newUser();
    expect(
      await verifyCredentials(db, {
        email: user.email,
        password: "wrong password",
      }),
    ).toBeNull();
    expect(
      await verifyCredentials(db, {
        email: `missing-${randomUUID()}@example.com`,
        password,
      }),
    ).toBeNull();
  });
});

describe("sessions", () => {
  it("resolves a session token to its user and stores only a hash", async () => {
    const user = await newUser();
    const now = new Date();
    const { token, expiresAt } = await createSession(db, user.id, now);

    expect(expiresAt.getTime()).toBe(now.getTime() + SESSION_TTL_MS);
    expect(await getSessionUser(db, token)).toEqual(user);

    const [stored] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.userId, user.id));
    expect(stored.tokenHash).toBe(hashSessionToken(token));
    expect(Object.values(stored)).not.toContain(token);
  });

  it("rejects unknown and expired tokens", async () => {
    const user = await newUser();
    const { token, expiresAt } = await createSession(db, user.id);

    expect(await getSessionUser(db, "not-a-real-token")).toBeNull();
    expect(await getSessionUser(db, token, expiresAt)).toBeNull();
    expect(
      await getSessionUser(db, token, new Date(expiresAt.getTime() - 1)),
    ).toEqual(user);
  });

  it("signs out by deleting the session", async () => {
    const user = await newUser();
    const { token } = await createSession(db, user.id);
    await deleteSession(db, token);
    expect(await getSessionUser(db, token)).toBeNull();
  });

  it("deletes expired sessions only", async () => {
    const user = await newUser();
    const past = new Date(Date.now() - 2 * SESSION_TTL_MS);
    const expired = await createSession(db, user.id, past);
    const live = await createSession(db, user.id);

    expect(await deleteExpiredSessions(db)).toBeGreaterThanOrEqual(1);
    expect(await getSessionUser(db, live.token)).toEqual(user);
    const remaining = await db
      .select()
      .from(sessions)
      .where(eq(sessions.tokenHash, hashSessionToken(expired.token)));
    expect(remaining).toHaveLength(0);
  });
});
