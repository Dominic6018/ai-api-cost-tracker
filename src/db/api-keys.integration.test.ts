import "dotenv/config";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateApiKey } from "@/lib/api-keys";
import { parseEnv } from "@/lib/env";
import { authenticateApiKey, createApiKey, revokeApiKey } from "./api-keys";
import { apiKeys, projects } from "./schema";

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
    });

    const [stored] = await db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.id, record.id));
    expect(stored.lastUsedAt?.toISOString()).toBe(at.toISOString());
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

    expect(await revokeApiKey(db, record.keyPrefix)).toBe(true);
    expect(await authenticateApiKey(db, key)).toEqual({ ok: false });

    // Revoking again finds no active key.
    expect(await revokeApiKey(db, record.keyPrefix)).toBe(false);
  });
});
