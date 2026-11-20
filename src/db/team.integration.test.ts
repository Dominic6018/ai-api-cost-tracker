import "dotenv/config";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseEnv } from "@/lib/env";
import { changeAccountRole, listOrganizationAccounts } from "./accounts";
import { createSession, createUser } from "./auth";
import { organizations, users, type UserRole } from "./schema";

// Runs against the database in DATABASE_URL after `npm run db:migrate`.
// Two connections, so the concurrent case below really runs concurrently.
const client = postgres(parseEnv().DATABASE_URL, {
  max: 2,
  onnotice: () => {},
});
const db = drizzle(client);

const run = randomUUID().slice(0, 8);
const password = "a long test password";
const organizationIds: string[] = [];
const userIds: string[] = [];
let ours: string;
let theirs: string;

async function organization(label: string) {
  const [created] = await db
    .insert(organizations)
    .values({ name: `Team ${label}`, slug: `it-team-${label}-${run}` })
    .returning();
  organizationIds.push(created.id);
  return created.id;
}

async function account(organizationId: string, name: string, role: UserRole) {
  const created = await createUser(db, {
    email: `${name}-${run}@example.com`,
    password,
    role,
    organizationId,
  });
  if (!created.ok) throw new Error("expected the account to be created");
  userIds.push(created.user.id);
  return created.user;
}

const roleOf = async (id: string) =>
  (await db.select({ role: users.role }).from(users).where(eq(users.id, id)))[0]
    ?.role;

beforeAll(async () => {
  ours = await organization("ours");
  theirs = await organization("theirs");
});

afterAll(async () => {
  // Deleting users cascades to their sessions.
  if (userIds.length > 0) {
    await db.delete(users).where(inArray(users.id, userIds));
  }
  await db
    .delete(organizations)
    .where(inArray(organizations.id, organizationIds));
  await client.end();
});

describe("listOrganizationAccounts", () => {
  it("lists one organization's accounts, by email, with active sessions", async () => {
    const zed = await account(ours, "zed", "viewer");
    const amy = await account(ours, "amy", "admin");
    await account(theirs, "other", "admin");
    await createSession(db, amy.id);
    await createSession(db, amy.id);
    // Expired a year ago, so it isn't counted.
    await createSession(db, zed.id, new Date(Date.now() - 400 * 86_400_000));

    const listed = await listOrganizationAccounts(db, ours);
    expect(listed.map((a) => [a.email, a.role, a.activeSessions])).toEqual([
      [amy.email, "admin", 2],
      [zed.email, "viewer", 0],
    ]);
    for (const row of listed) {
      expect(Object.keys(row).sort()).toEqual(
        ["activeSessions", "createdAt", "email", "id", "role"].sort(),
      );
    }
  });
});

describe("changeAccountRole", () => {
  it("changes a role within the organization only", async () => {
    const organizationId = await organization("change");
    await account(organizationId, "boss", "admin");
    const dev = await account(organizationId, "dev", "viewer");

    expect(
      await changeAccountRole(db, {
        organizationId,
        userId: dev.id,
        role: "member",
      }),
    ).toEqual({
      ok: true,
      email: dev.email,
      role: "member",
      previousRole: "viewer",
    });
    expect(await roleOf(dev.id)).toBe("member");

    // Setting the same role again changes nothing.
    expect(
      await changeAccountRole(db, {
        organizationId,
        userId: dev.id,
        role: "member",
      }),
    ).toMatchObject({ ok: true, role: "member", previousRole: "member" });

    // Not from another organization, nor for an id that isn't one.
    for (const userId of [dev.id, randomUUID(), "not-a-uuid"]) {
      expect(
        await changeAccountRole(db, {
          organizationId: theirs,
          userId,
          role: "admin",
        }),
      ).toEqual({ ok: false, error: "not_found" });
    }
    expect(await roleOf(dev.id)).toBe("member");
  });

  it("keeps at least one admin in the organization", async () => {
    const organizationId = await organization("last");
    const solo = await account(organizationId, "solo", "admin");
    for (const role of ["member", "viewer"] as const) {
      expect(
        await changeAccountRole(db, { organizationId, userId: solo.id, role }),
      ).toEqual({ ok: false, error: "last_admin" });
    }
    expect(await roleOf(solo.id)).toBe("admin");

    // With a second admin, either may step down, but not both.
    const second = await account(organizationId, "second", "member");
    await changeAccountRole(db, {
      organizationId,
      userId: second.id,
      role: "admin",
    });
    expect(
      await changeAccountRole(db, {
        organizationId,
        userId: solo.id,
        role: "viewer",
      }),
    ).toMatchObject({ ok: true, previousRole: "admin", role: "viewer" });
    expect(
      await changeAccountRole(db, {
        organizationId,
        userId: second.id,
        role: "member",
      }),
    ).toEqual({ ok: false, error: "last_admin" });
  });

  it("lets only one of two admins demoting each other at once succeed", async () => {
    const organizationId = await organization("race");
    const a = await account(organizationId, "race-a", "admin");
    const b = await account(organizationId, "race-b", "admin");

    const results = await Promise.all([
      changeAccountRole(db, { organizationId, userId: a.id, role: "member" }),
      changeAccountRole(db, { organizationId, userId: b.id, role: "member" }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([
      { ok: false, error: "last_admin" },
    ]);
    const roles = [await roleOf(a.id), await roleOf(b.id)];
    expect(roles.filter((role) => role === "admin")).toHaveLength(1);
  });
});
