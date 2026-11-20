import "dotenv/config";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateApiKey } from "@/lib/api-keys";
import { parseEnv } from "@/lib/env";
import {
  authenticateApiKey,
  createApiKey,
  createProjectApiKey,
  listProjectApiKeys,
  revokeApiKey,
  revokeProjectApiKey,
} from "./api-keys";
import {
  apiKeys,
  DEFAULT_ORGANIZATION_ID,
  organizations,
  projects,
} from "./schema";

// Runs against the database in DATABASE_URL after `npm run db:migrate`.
const client = postgres(parseEnv().DATABASE_URL, {
  max: 1,
  onnotice: () => {},
});
const db = drizzle(client);

const slug = `it-${randomUUID()}`;
let projectId: string;

beforeAll(async () => {
  const [project] = await db
    .insert(projects)
    .values({ name: "API key test", slug })
    .returning();
  projectId = project.id;
});

afterAll(async () => {
  // Deleting the project cascades to its API keys.
  await db.delete(projects).where(eq(projects.id, projectId));
  await client.end();
});

async function newKey(name = "test") {
  const result = await createApiKey(db, { projectSlug: slug, name });
  if (!result.ok) throw new Error("expected key creation to succeed");
  return result;
}

describe("createApiKey", () => {
  it("stores only the prefix and hash, never the key", async () => {
    const { key, record } = await newKey("ci");

    const [stored] = await db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.id, record.id));
    expect(stored.projectId).toBe(projectId);
    expect(stored.name).toBe("ci");
    expect(key.startsWith(stored.keyPrefix)).toBe(true);
    expect(Object.values(stored)).not.toContain(key);
    expect(stored.keyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.lastUsedAt).toBeNull();
    expect(stored.revokedAt).toBeNull();
  });

  it("returns project_not_found for an unknown slug", async () => {
    expect(
      await createApiKey(db, {
        projectSlug: `missing-${randomUUID()}`,
        name: "x",
      }),
    ).toEqual({ ok: false, error: "project_not_found" });
  });
});

describe("authenticateApiKey", () => {
  it("resolves a valid key to its project and records last use", async () => {
    const { key, record } = await newKey();
    const at = new Date("2026-11-01T12:00:00Z");

    expect(await authenticateApiKey(db, key, at)).toEqual({
      ok: true,
      projectId,
      apiKeyId: record.id,
      // Keys send usage unless created for reading reports.
      scope: "ingest",
    });

    const [stored] = await db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.id, record.id));
    expect(stored.lastUsedAt?.toISOString()).toBe(at.toISOString());
  });

  it("reports a read key's scope", async () => {
    const result = await createApiKey(db, {
      projectSlug: slug,
      name: "reports",
      scope: "read",
    });
    if (!result.ok) throw new Error("expected key creation to succeed");
    expect(result.record.scope).toBe("read");
    expect(await authenticateApiKey(db, result.key)).toMatchObject({
      ok: true,
      scope: "read",
    });
  });

  it("rejects an unknown but well-formed key", async () => {
    expect(await authenticateApiKey(db, generateApiKey().key)).toEqual({
      ok: false,
    });
  });

  it("rejects a key whose prefix matches but secret does not", async () => {
    const { key } = await newKey();
    const forged = key.slice(0, -1) + (key.endsWith("A") ? "B" : "A");
    expect(await authenticateApiKey(db, forged)).toEqual({ ok: false });
  });

  it("rejects a malformed key without querying", async () => {
    expect(await authenticateApiKey(db, "not-a-key")).toEqual({ ok: false });
  });

  it("rejects a key after it is revoked", async () => {
    const { key, record } = await newKey();
    expect((await authenticateApiKey(db, key)).ok).toBe(true);

    expect(await revokeApiKey(db, record.keyPrefix)).toEqual({
      organizationId: DEFAULT_ORGANIZATION_ID,
    });
    expect(await authenticateApiKey(db, key)).toEqual({ ok: false });

    // Revoking again finds no active key.
    expect(await revokeApiKey(db, record.keyPrefix)).toBeNull();
  });
});

describe("the dashboard's key management", () => {
  const ours = { organizationId: DEFAULT_ORGANIZATION_ID };
  let otherOrganizationId: string;
  let otherProjectId: string;
  let theirs: { organizationId: string };

  beforeAll(async () => {
    const [organization] = await db
      .insert(organizations)
      .values({ name: "Key test other", slug: `it-keys-${randomUUID()}` })
      .returning();
    otherOrganizationId = organization.id;
    theirs = { organizationId: organization.id };
    const [project] = await db
      .insert(projects)
      .values({
        name: "Other key test",
        slug: `it-${randomUUID()}`,
        organizationId: organization.id,
      })
      .returning();
    otherProjectId = project.id;
  });

  afterAll(async () => {
    await db.delete(projects).where(eq(projects.id, otherProjectId));
    await db
      .delete(organizations)
      .where(eq(organizations.id, otherOrganizationId));
  });

  it("creates a working key for a project in scope, keeping no secret", async () => {
    const created = await createProjectApiKey(db, ours, {
      projectId,
      name: "dashboard",
      keyScope: "read",
    });
    if (!created.ok) throw new Error("expected key creation to succeed");
    expect(created.record).toMatchObject({
      projectId,
      name: "dashboard",
      scope: "read",
      revokedAt: null,
    });
    expect(created.record).not.toHaveProperty("keyHash");
    expect(created.key.startsWith(created.record.keyPrefix)).toBe(true);
    expect(await authenticateApiKey(db, created.key)).toMatchObject({
      ok: true,
      projectId,
      scope: "read",
    });

    const listed = await listProjectApiKeys(db, ours, projectId);
    const row = listed.find((key) => key.id === created.record.id);
    expect(row).toBeDefined();
    expect(row).not.toHaveProperty("keyHash");
    expect(Object.values(row!)).not.toContain(created.key);
  });

  it("refuses another organization's project, or a project that isn't one", async () => {
    for (const id of [otherProjectId, randomUUID(), "not-a-uuid"]) {
      expect(
        await createProjectApiKey(db, ours, {
          projectId: id,
          name: "x",
          keyScope: "ingest",
        }),
        id,
      ).toEqual({ ok: false, error: "not_found" });
    }
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(apiKeys)
      .where(eq(apiKeys.projectId, otherProjectId));
    expect(count).toBe(0);
  });

  it("lists only a project in scope, active keys first", async () => {
    const theirKey = await createProjectApiKey(db, theirs, {
      projectId: otherProjectId,
      name: "theirs",
      keyScope: "ingest",
    });
    expect(theirKey.ok).toBe(true);
    expect(await listProjectApiKeys(db, ours, otherProjectId)).toEqual([]);
    expect(await listProjectApiKeys(db, theirs, projectId)).toEqual([]);
    expect(await listProjectApiKeys(db, ours, "not-a-uuid")).toEqual([]);
    expect(
      (await listProjectApiKeys(db, theirs, otherProjectId)).map((k) => k.name),
    ).toEqual(["theirs"]);

    const old = await newKey("to revoke");
    await revokeApiKey(db, old.record.keyPrefix);
    const listed = await listProjectApiKeys(db, ours, projectId);
    const firstRevoked = listed.findIndex((key) => key.revokedAt !== null);
    expect(firstRevoked).toBeGreaterThan(0);
    expect(listed.slice(firstRevoked).every((k) => k.revokedAt)).toBe(true);
  });

  it("revokes one active key of a project in scope, once", async () => {
    const { key, record } = await newKey("revoke me");
    const at = new Date("2026-11-21T09:00:00Z");

    // Not from another organization, nor through another project.
    expect(
      await revokeProjectApiKey(db, theirs, { projectId, keyId: record.id }),
    ).toBeNull();
    expect(
      await revokeProjectApiKey(db, theirs, {
        projectId: otherProjectId,
        keyId: record.id,
      }),
    ).toBeNull();
    expect((await authenticateApiKey(db, key)).ok).toBe(true);

    const revoked = await revokeProjectApiKey(
      db,
      ours,
      { projectId, keyId: record.id },
      at,
    );
    expect(revoked).toMatchObject({ id: record.id, name: "revoke me" });
    expect(revoked).not.toHaveProperty("keyHash");
    expect(revoked?.revokedAt?.toISOString()).toBe(at.toISOString());
    expect(await authenticateApiKey(db, key)).toEqual({ ok: false });
    expect(
      await revokeProjectApiKey(db, ours, { projectId, keyId: record.id }),
    ).toBeNull();
    expect(
      await revokeProjectApiKey(db, ours, { projectId, keyId: "nope" }),
    ).toBeNull();
  });
});
