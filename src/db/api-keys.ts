import { and, eq, isNull } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import {
  apiKeyMatchesHash,
  apiKeyPrefix,
  generateApiKey,
  isWellFormedApiKey,
} from "@/lib/api-keys";
import { apiKeys, projects, type ApiKey } from "./schema";

/** Any Drizzle Postgres database, so callers and tests can pass their own. */
type Database = Pick<
  PgDatabase<PgQueryResultHKT>,
  "select" | "insert" | "update"
>;

const UNIQUE_VIOLATION = "23505";
const MAX_CREATE_ATTEMPTS = 3;

function pgErrorCode(error: unknown): string | undefined {
  const cause = (error as { cause?: unknown })?.cause ?? error;
  const code = (cause as { code?: unknown })?.code;
  return typeof code === "string" ? code : undefined;
}

export type CreateApiKeyResult =
  | { ok: true; key: string; record: ApiKey }
  | { ok: false; error: "project_not_found" };

/**
 * Creates a key for a project, identified by slug. The returned `key` is the
 * only copy of the secret; just its prefix and hash are stored.
 */
export async function createApiKey(
  db: Database,
  { projectSlug, name }: { projectSlug: string; name: string },
): Promise<CreateApiKeyResult> {
  const [project] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.slug, projectSlug));
  if (!project) return { ok: false, error: "project_not_found" };

  // A prefix collision is astronomically unlikely, but retry rather than fail.
  for (let attempt = 1; ; attempt++) {
    const generated = generateApiKey();
    try {
      const [record] = await db
        .insert(apiKeys)
        .values({
          projectId: project.id,
          name,
          keyPrefix: generated.prefix,
          keyHash: generated.hash,
        })
        .returning();
      return { ok: true, key: generated.key, record };
    } catch (error) {
      if (pgErrorCode(error) !== UNIQUE_VIOLATION) throw error;
      if (attempt >= MAX_CREATE_ATTEMPTS) throw error;
    }
  }
}

export type AuthenticateResult =
  { ok: true; projectId: string; apiKeyId: string } | { ok: false };

/**
 * Resolves a presented key to its project. Fails for malformed, unknown and
 * revoked keys alike, so callers can't tell them apart. Records last use.
 */
export async function authenticateApiKey(
  db: Database,
  key: string,
  now: Date = new Date(),
): Promise<AuthenticateResult> {
  if (!isWellFormedApiKey(key)) return { ok: false };

  const [record] = await db
    .select()
    .from(apiKeys)
    .where(
      and(eq(apiKeys.keyPrefix, apiKeyPrefix(key)), isNull(apiKeys.revokedAt)),
    );
  if (!record || !apiKeyMatchesHash(key, record.keyHash)) return { ok: false };

  await db
    .update(apiKeys)
    .set({ lastUsedAt: now })
    .where(eq(apiKeys.id, record.id));

  return { ok: true, projectId: record.projectId, apiKeyId: record.id };
}

/** Revokes a key by its displayed prefix. Returns false if no active key matched. */
export async function revokeApiKey(
  db: Database,
  prefix: string,
  now: Date = new Date(),
): Promise<boolean> {
  const revoked = await db
    .update(apiKeys)
    .set({ revokedAt: now })
    .where(and(eq(apiKeys.keyPrefix, prefix), isNull(apiKeys.revokedAt)))
    .returning({ id: apiKeys.id });
  return revoked.length > 0;
}
