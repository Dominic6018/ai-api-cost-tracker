import "dotenv/config";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseEnv } from "@/lib/env";
import { INVITATION_TTL_MS } from "@/lib/invitations";
import { verifyCredentials } from "./auth";
import { createUser } from "./auth";
import {
  acceptInvitation,
  createInvitation,
  findUsableInvitation,
  listPendingInvitations,
  revokeInvitation,
} from "./invitations";
import { accountInvitations, organizations, users } from "./schema";
import { hashPassword } from "@/lib/passwords";

// Runs against the database in DATABASE_URL after `npm run db:migrate`.
// Two connections, so the concurrent case really runs concurrently.
const client = postgres(parseEnv().DATABASE_URL, {
  max: 2,
  onnotice: () => {},
});
const db = drizzle(client);

const run = randomUUID().slice(0, 8);
const password = "a long test password";
const organizationIds: string[] = [];
let ours: string;
let theirs: string;
let admin: { id: string; email: string };
let passwordHash: string;

const emailFor = (name: string) => `invite-${name}-${run}@example.com`;

async function organization(label: string) {
  const [created] = await db
    .insert(organizations)
    .values({ name: `Invite ${label} ${run}`, slug: `it-inv-${label}-${run}` })
    .returning();
  organizationIds.push(created.id);
  return created.id;
}

async function invite(
  email: string,
  organizationId = ours,
  now = new Date(),
  role: "admin" | "member" | "viewer" = "member",
) {
  const created = await createInvitation(
    db,
    { organizationId, email, role, invitedBy: admin },
    now,
  );
  if (!created.ok) throw new Error(`expected an invitation for ${email}`);
  return created;
}

beforeAll(async () => {
  ours = await organization("ours");
  theirs = await organization("theirs");
  const created = await createUser(db, {
    email: emailFor("admin"),
    password,
    organizationId: ours,
  });
  if (!created.ok) throw new Error("expected the admin to be created");
  admin = created.user;
  passwordHash = await hashPassword(password);
});

afterAll(async () => {
  // Deleting the organizations cascades to their invitations.
  await db.delete(users).where(inArray(users.organizationId, organizationIds));
  await db
    .delete(organizations)
    .where(inArray(organizations.id, organizationIds));
  await client.end();
});

describe("createInvitation", () => {
  it("stores the invitation with only the link's hash", async () => {
    const now = new Date("2026-11-21T10:00:00Z");
    const { token, invitation } = await invite(
      ` ${emailFor("Stored").toUpperCase()} `,
      ours,
      now,
      "viewer",
    );
    expect(invitation).toMatchObject({
      organizationId: ours,
      email: emailFor("stored"),
      role: "viewer",
      invitedBy: admin.id,
      invitedByLabel: admin.email,
    });
    expect(invitation.expiresAt.getTime()).toBe(
      now.getTime() + INVITATION_TTL_MS,
    );
    const [stored] = await db
      .select()
      .from(accountInvitations)
      .where(eq(accountInvitations.id, invitation.id));
    expect(Object.values(stored)).not.toContain(token);
    expect(stored.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses an email with an account or an open invitation anywhere", async () => {
    const email = emailFor("taken");
    await invite(email);
    for (const organizationId of [ours, theirs]) {
      expect(
        await createInvitation(db, {
          organizationId,
          email,
          role: "member",
          invitedBy: admin,
        }),
      ).toEqual({ ok: false, error: "unavailable" });
    }
    expect(
      await createInvitation(db, {
        organizationId: theirs,
        email: admin.email.toUpperCase(),
        role: "member",
        invitedBy: admin,
      }),
    ).toEqual({ ok: false, error: "unavailable" });
  });

  it("replaces an expired invitation for the email", async () => {
    const email = emailFor("again");
    const old = await invite(email, ours, new Date("2026-01-01T00:00:00Z"));
    const fresh = await invite(email);
    expect(fresh.invitation.id).not.toBe(old.invitation.id);
    const [closed] = await db
      .select()
      .from(accountInvitations)
      .where(eq(accountInvitations.id, old.invitation.id));
    expect(closed.revokedAt).not.toBeNull();
    expect(await findUsableInvitation(db, old.token)).toBeNull();
  });
});

describe("listing and revoking", () => {
  it("lists and revokes only the organization's open invitations", async () => {
    const mine = await invite(emailFor("mine"));
    const other = await invite(emailFor("other"), theirs);

    const listed = await listPendingInvitations(db, ours);
    expect(listed.map((i) => i.email)).toContain(emailFor("mine"));
    expect(listed.map((i) => i.email)).not.toContain(emailFor("other"));
    for (const row of listed) expect(row).not.toHaveProperty("tokenHash");

    for (const invitationId of [other.invitation.id, randomUUID(), "x"]) {
      expect(
        await revokeInvitation(db, { organizationId: ours, invitationId }),
      ).toBeNull();
    }
    expect(await findUsableInvitation(db, other.token)).not.toBeNull();

    const revoked = await revokeInvitation(db, {
      organizationId: ours,
      invitationId: mine.invitation.id,
    });
    expect(revoked).toMatchObject({ email: emailFor("mine") });
    expect(await findUsableInvitation(db, mine.token)).toBeNull();
    expect(
      await revokeInvitation(db, {
        organizationId: ours,
        invitationId: mine.invitation.id,
      }),
    ).toBeNull();
    expect(
      (await listPendingInvitations(db, ours)).map((i) => i.email),
    ).not.toContain(emailFor("mine"));
  });
});

describe("accepting", () => {
  it("opens a usable link with its organization", async () => {
    const { token } = await invite(emailFor("open"));
    const usable = await findUsableInvitation(db, token);
    expect(usable).toMatchObject({
      organizationName: `Invite ours ${run}`,
      invitation: { email: emailFor("open"), role: "member" },
    });
    expect(await findUsableInvitation(db, "not-a-token")).toBeNull();
    expect(await findUsableInvitation(db, "A".repeat(43))).toBeNull();
  });

  it("makes the account in the invitation's organization and role, once", async () => {
    const { token, invitation } = await invite(
      emailFor("joins"),
      theirs,
      new Date(),
      "viewer",
    );
    const accepted = await db.transaction((tx) =>
      acceptInvitation(tx, { token, passwordHash }),
    );
    if (!accepted.ok) throw new Error("expected the invitation to be accepted");
    expect(accepted.user).toMatchObject({
      email: emailFor("joins"),
      role: "viewer",
      organizationId: theirs,
    });
    expect(accepted.invitation).toMatchObject({
      id: invitation.id,
      acceptedUserId: accepted.user.id,
    });
    expect(
      await verifyCredentials(db, { email: emailFor("joins"), password }),
    ).toMatchObject({ id: accepted.user.id });

    expect(
      await db.transaction((tx) =>
        acceptInvitation(tx, { token, passwordHash }),
      ),
    ).toEqual({ ok: false, error: "invalid" });
    expect(await findUsableInvitation(db, token)).toBeNull();
  });

  it("refuses an expired or revoked link", async () => {
    const expired = await invite(
      emailFor("late"),
      ours,
      new Date(Date.now() - INVITATION_TTL_MS - 1000),
    );
    const revoked = await invite(emailFor("gone"));
    await revokeInvitation(db, {
      organizationId: ours,
      invitationId: revoked.invitation.id,
    });
    for (const { token } of [expired, revoked]) {
      expect(await findUsableInvitation(db, token)).toBeNull();
      expect(
        await db.transaction((tx) =>
          acceptInvitation(tx, { token, passwordHash }),
        ),
      ).toEqual({ ok: false, error: "invalid" });
    }
  });

  it("refuses when the email got an account since", async () => {
    const email = emailFor("raced");
    const { token } = await invite(email);
    await createUser(db, { email, password, organizationId: theirs });
    expect(
      await db.transaction((tx) =>
        acceptInvitation(tx, { token, passwordHash }),
      ),
    ).toEqual({ ok: false, error: "email_taken" });
  });

  it("makes one account when a link is used twice at once", async () => {
    const email = emailFor("twice");
    const { token } = await invite(email);
    const results = await Promise.all(
      [1, 2].map(() =>
        db.transaction((tx) => acceptInvitation(tx, { token, passwordHash })),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([
      { ok: false, error: "invalid" },
    ]);
    const made = await db.select().from(users).where(eq(users.email, email));
    expect(made).toHaveLength(1);
  });
});
