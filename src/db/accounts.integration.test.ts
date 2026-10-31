import "dotenv/config";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { parseEnv } from "@/lib/env";
import { RATE_LIMITS, rateLimitKey } from "@/lib/rate-limit";
import { listUsers, resetPassword, revokeSessions } from "./accounts";
import {
  createSession,
  createUser,
  getSessionUser,
  verifyCredentials,
} from "./auth";
import { hitRateLimit } from "./rate-limits";
import { rateLimits, sessions, users } from "./schema";
import { signIn } from "./sign-in";

// Runs against the database in DATABASE_URL after `npm run db:migrate`.
const client = postgres(parseEnv().DATABASE_URL, {
  max: 1,
  onnotice: () => {},
});
const db = drizzle(client);

const createdUserIds: string[] = [];
const password = "a long test password";
const newPassword = "a different long password";

afterAll(async () => {
  // Deleting users cascades to their sessions.
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await client.end();
});

async function newUser() {
  const result = await createUser(db, {
    email: `it-${randomUUID()}@example.com`,
    password,
  });
  if (!result.ok) throw new Error("expected user creation to succeed");
  createdUserIds.push(result.user.id);
  return result.user;
}

describe("resetPassword", () => {
  it("replaces the password and revokes every session", async () => {
    const user = await newUser();
    const first = await createSession(db, user.id);
    const second = await createSession(db, user.id);

    expect(
      await resetPassword(db, {
        email: user.email.toUpperCase(),
        password: newPassword,
      }),
    ).toEqual({ ok: true, email: user.email, revokedSessions: 2 });

    expect(await getSessionUser(db, first.token)).toBeNull();
    expect(await getSessionUser(db, second.token)).toBeNull();
    expect(await verifyCredentials(db, { email: user.email, password })).toBe(
      null,
    );
    expect(
      await verifyCredentials(db, {
        email: user.email,
        password: newPassword,
      }),
    ).toEqual({ id: user.id, email: user.email });
  });

  it("lifts a sign-in lockout on the email", async () => {
    const user = await newUser();
    const key = rateLimitKey(RATE_LIMITS.signInEmail, user.email);
    try {
      for (let i = 0; i <= RATE_LIMITS.signInEmail.limit; i++) {
        await hitRateLimit(db, RATE_LIMITS.signInEmail, key);
      }
      const clientIp = `it-${randomUUID()}`;
      expect(
        await signIn(db, { email: user.email, password, clientIp }),
      ).toEqual({ ok: false, error: "rate_limited" });

      await resetPassword(db, { email: user.email, password: newPassword });
      const result = await signIn(db, {
        email: user.email,
        password: newPassword,
        clientIp,
      });
      expect(result.ok).toBe(true);
    } finally {
      await db.delete(rateLimits).where(eq(rateLimits.key, key));
    }
  });

  it("reports an unknown email and changes nothing", async () => {
    expect(
      await resetPassword(db, {
        email: `nobody-${randomUUID()}@example.com`,
        password: newPassword,
      }),
    ).toEqual({ ok: false, error: "user_not_found" });
  });
});

describe("revokeSessions", () => {
  it("signs one user out everywhere and leaves others signed in", async () => {
    const user = await newUser();
    const other = await newUser();
    const mine = await createSession(db, user.id);
    const theirs = await createSession(db, other.id);

    expect(await revokeSessions(db, user.email)).toEqual({
      ok: true,
      email: user.email,
      revokedSessions: 1,
    });
    expect(await getSessionUser(db, mine.token)).toBeNull();
    expect(await getSessionUser(db, theirs.token)).toEqual(other);
    // The password still works; only sessions were revoked.
    expect(
      await verifyCredentials(db, { email: user.email, password }),
    ).not.toBeNull();

    expect(await revokeSessions(db, user.email)).toEqual({
      ok: true,
      email: user.email,
      revokedSessions: 0,
    });
  });

  it("reports an unknown email", async () => {
    expect(
      await revokeSessions(db, `nobody-${randomUUID()}@example.com`),
    ).toEqual({ ok: false, error: "user_not_found" });
  });
});

describe("listUsers", () => {
  it("lists emails with active session counts, and never hashes", async () => {
    const user = await newUser();
    const idle = await newUser();
    const now = new Date();
    await createSession(db, user.id, now);
    await createSession(db, user.id, now);
    // An expired session isn't active.
    await db.insert(sessions).values({
      userId: user.id,
      tokenHash: `expired-${randomUUID()}`,
      expiresAt: new Date(now.getTime() - 1000),
    });

    const accounts = await listUsers(db, now);
    const byEmail = new Map(accounts.map((a) => [a.email, a]));
    expect(byEmail.get(user.email)?.activeSessions).toBe(2);
    expect(byEmail.get(idle.email)?.activeSessions).toBe(0);
    expect(Object.keys(accounts[0]).sort()).toEqual([
      "activeSessions",
      "createdAt",
      "email",
    ]);
  });
});
