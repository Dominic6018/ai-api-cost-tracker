import "dotenv/config";
import { randomUUID } from "node:crypto";
import { eq, inArray, like } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { parseEnv } from "@/lib/env";
import {
  RATE_LIMITS,
  rateLimitKey,
  type RateLimitRule,
} from "@/lib/rate-limit";
import { createUser } from "./auth";
import {
  clearRateLimit,
  deleteExpiredRateLimits,
  hitRateLimit,
  undoRateLimitHit,
} from "./rate-limits";
import { rateLimits, users } from "./schema";
import { signIn } from "./sign-in";

// Runs against the database in DATABASE_URL after `npm run db:migrate`.
const client = postgres(parseEnv().DATABASE_URL, {
  max: 1,
  onnotice: () => {},
});
const db = drizzle(client);

const rule: RateLimitRule = { scope: "it", limit: 3, windowMs: 60_000 };
const createdUserIds: string[] = [];
const password = "a long test password";

afterAll(async () => {
  await db.delete(rateLimits).where(like(rateLimits.key, "it:%"));
  await db.delete(rateLimits).where(like(rateLimits.key, "sign-in:%"));
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await client.end();
});

const newKey = () => `it:${randomUUID()}`;

async function stored(key: string) {
  const [row] = await db
    .select()
    .from(rateLimits)
    .where(eq(rateLimits.key, key));
  return row;
}

describe("hitRateLimit", () => {
  it("allows `limit` attempts per window, then refuses", async () => {
    const key = newKey();
    const now = new Date();
    const results = [];
    for (let i = 0; i < 5; i++) {
      results.push(await hitRateLimit(db, rule, key, now));
    }
    expect(results.map((r) => r.limited)).toEqual([
      false,
      false,
      false,
      true,
      true,
    ]);
    // Refused attempts don't push the window back.
    const resetAt = now.getTime() + rule.windowMs;
    expect(results.every((r) => r.resetAt.getTime() === resetAt)).toBe(true);
    expect((await stored(key)).count).toBe(5);
  });

  it("starts a new window once the old one has ended", async () => {
    const key = newKey();
    const start = new Date();
    for (let i = 0; i < 4; i++) await hitRateLimit(db, rule, key, start);

    const later = new Date(start.getTime() + rule.windowMs);
    const result = await hitRateLimit(db, rule, key, later);
    expect(result).toEqual({
      limited: false,
      resetAt: new Date(later.getTime() + rule.windowMs),
    });
    expect((await stored(key)).count).toBe(1);
  });

  it("counts concurrent attempts exactly", async () => {
    const pool = postgres(parseEnv().DATABASE_URL, {
      max: 10,
      onnotice: () => {},
    });
    try {
      const key = newKey();
      const now = new Date();
      const results = await Promise.all(
        Array.from({ length: 20 }, () =>
          hitRateLimit(drizzle(pool), rule, key, now),
        ),
      );
      expect(results.filter((r) => !r.limited)).toHaveLength(rule.limit);
      expect((await stored(key)).count).toBe(20);
    } finally {
      await pool.end();
    }
  });

  it("clears out counters whose window has ended", async () => {
    const old = newKey();
    const start = new Date();
    await hitRateLimit(db, rule, old, start);

    const later = new Date(start.getTime() + rule.windowMs);
    const fresh = newKey();
    await hitRateLimit(db, rule, fresh, later);
    expect(await stored(old)).toBeUndefined();
    expect(await stored(fresh)).toBeDefined();
  });
});

describe("undoRateLimitHit and clearRateLimit", () => {
  it("take back one attempt, or all of them", async () => {
    const key = newKey();
    const now = new Date();
    for (let i = 0; i < 3; i++) await hitRateLimit(db, rule, key, now);

    await undoRateLimitHit(db, key, now);
    expect((await stored(key)).count).toBe(2);

    await clearRateLimit(db, key);
    expect(await stored(key)).toBeUndefined();
    // Undoing with nothing stored is a no-op.
    await undoRateLimitHit(db, key, now);
    expect(await stored(key)).toBeUndefined();
  });
});

describe("deleteExpiredRateLimits", () => {
  it("deletes only counters whose window has ended", async () => {
    const key = newKey();
    const now = new Date();
    await hitRateLimit(db, rule, key, now);
    await deleteExpiredRateLimits(db, now);
    expect(await stored(key)).toBeDefined();
    expect(
      await deleteExpiredRateLimits(
        db,
        new Date(now.getTime() + rule.windowMs),
      ),
    ).toBeGreaterThanOrEqual(1);
    expect(await stored(key)).toBeUndefined();
  });
});

describe("signIn", () => {
  async function newUser() {
    const email = `it-${randomUUID()}@example.com`;
    const result = await createUser(db, { email, password });
    if (!result.ok) throw new Error("expected user creation to succeed");
    createdUserIds.push(result.user.id);
    return email;
  }
  const newIp = () => `it-${randomUUID()}`;
  const { limit: emailLimit } = RATE_LIMITS.signInEmail;
  const { limit: ipLimit } = RATE_LIMITS.signInIp;

  it("signs in with the right password", async () => {
    const email = await newUser();
    const result = await signIn(db, { email, password, clientIp: newIp() });
    expect(result.ok && result.user.email).toBe(email);
  });

  it("locks an email after repeated failures, even for the right password", async () => {
    const email = await newUser();
    for (let i = 0; i < emailLimit; i++) {
      expect(
        await signIn(db, { email, password: "wrong", clientIp: newIp() }),
      ).toEqual({ ok: false, error: "invalid_credentials" });
    }
    expect(await signIn(db, { email, password, clientIp: newIp() })).toEqual({
      ok: false,
      error: "rate_limited",
    });
    // Case and spacing don't give an attacker a fresh counter.
    expect(
      await signIn(db, {
        email: ` ${email.toUpperCase()} `,
        password,
        clientIp: newIp(),
      }),
    ).toEqual({ ok: false, error: "rate_limited" });
  });

  it("resets the email's count after a successful sign-in", async () => {
    const email = await newUser();
    const clientIp = newIp();
    for (let round = 0; round < 2; round++) {
      for (let i = 0; i < emailLimit - 1; i++) {
        await signIn(db, { email, password: "wrong", clientIp });
      }
      expect((await signIn(db, { email, password, clientIp })).ok).toBe(true);
    }
  });

  it("limits one client IP across many emails", async () => {
    const clientIp = newIp();
    for (let i = 0; i < ipLimit; i++) {
      await signIn(db, {
        email: `it-${randomUUID()}@example.com`,
        password: "wrong",
        clientIp,
      });
    }
    const email = await newUser();
    expect(await signIn(db, { email, password, clientIp })).toEqual({
      ok: false,
      error: "rate_limited",
    });
    // Another address is unaffected.
    expect((await signIn(db, { email, password, clientIp: newIp() })).ok).toBe(
      true,
    );
  });

  it("doesn't count successful sign-ins against the client IP", async () => {
    const email = await newUser();
    const clientIp = newIp();
    for (let i = 0; i < ipLimit + 1; i++) {
      expect((await signIn(db, { email, password, clientIp })).ok).toBe(true);
    }
    const key = rateLimitKey(RATE_LIMITS.signInIp, clientIp);
    expect((await stored(key)).count).toBe(0);
  });
});
