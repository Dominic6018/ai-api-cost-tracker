import { and, eq, isNull } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import {
  apiKeyMatchesHash,
  apiKeyPrefix,
  generateApiKey,
  isWellFormedApiKey,
} from "@/lib/api-keys";
import {
  apiKeys,
  organizations,
  projects,
  type ApiKey,
  type ApiKeyScope,
} from "./schema";

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
  | { ok: true; key: string; record: ApiKey; organizationId: string }
  | { ok: false; error: "project_not_found" | "project_ambiguous" };

/**
 * Creates a key for a project, identified by slug, and by organization
 * slug when more than one organization has that project slug. The
 * returned `key` is the only copy of the secret; just its prefix and hash
 * are stored.
 */
export async function createApiKey(
  db: Database,
  {
    projectSlug,
    organizationSlug,
    name,
    scope = "ingest",
  }: {
    projectSlug: string;
    organizationSlug?: string;
    name: string;
    scope?: ApiKeyScope;
  },
): Promise<CreateApiKeyResult> {
  const matches = await db
    .select({ id: projects.id, organizationId: projects.organizationId })
    .from(projects)
    .innerJoin(organizations, eq(organizations.id, projects.organizationId))
    .where(
      and(
        eq(projects.slug, projectSlug),
        organizationSlug ? eq(organizations.slug, organizationSlug) : undefined,
      ),
    )
    .limit(2);
  if (matches.length === 0) return { ok: false, error: "project_not_found" };
  if (matches.length > 1) return { ok: false, error: "project_ambiguous" };
  const [project] = matches;

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
          scope,
        })
        .returning();
      return {
        ok: true,
        key: generated.key,
        record,
        organizationId: project.organizationId,
      };
    } catch (error) {
      if (pgErrorCode(error) !== UNIQUE_VIOLATION) throw error;
      if (attempt >= MAX_CREATE_ATTEMPTS) throw error;
    }
  }
}

export type AuthenticateResult =
  | { ok: true; projectId: string; apiKeyId: string; scope: ApiKeyScope }
  | { ok: false };

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

  return {
    ok: true,
    projectId: record.projectId,
    apiKeyId: record.id,
    scope: record.scope,
  };
}

/**
 * Revokes a key by its displayed prefix. Returns the organization of the
 * key's project, or null if no active key matched.
 */
export async function revokeApiKey(
  db: Database,
  prefix: string,
  now: Date = new Date(),
): Promise<{ organizationId: string } | null> {
  const [revoked] = await db
    .update(apiKeys)
    .set({ revokedAt: now })
    .where(and(eq(apiKeys.keyPrefix, prefix), isNull(apiKeys.revokedAt)))
    .returning({ projectId: apiKeys.projectId });
  if (!revoked) return null;
  const [project] = await db
    .select({ organizationId: projects.organizationId })
    .from(projects)
    .where(eq(projects.id, revoked.projectId));
  return project ?? null;
}
