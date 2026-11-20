import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import {
  apiKeyMatchesHash,
  apiKeyPrefix,
  generateApiKey,
  isWellFormedApiKey,
} from "@/lib/api-keys";
import { isUuid } from "@/lib/ids";
import {
  inOrganization,
  projectInOrganization,
  type OrganizationScope,
} from "./scope";
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
  const { key, record } = await insertKey(db, project.id, name, scope);
  return { ok: true, key, record, organizationId: project.organizationId };
}

async function insertKey(
  db: Database,
  projectId: string,
  name: string,
  scope: ApiKeyScope,
): Promise<{ key: string; record: ApiKey }> {
  // A prefix collision is astronomically unlikely, but retry rather than fail.
  for (let attempt = 1; ; attempt++) {
    const generated = generateApiKey();
    try {
      const [record] = await db
        .insert(apiKeys)
        .values({
          projectId,
          name,
          keyPrefix: generated.prefix,
          keyHash: generated.hash,
          scope,
        })
        .returning();
      return { key: generated.key, record };
    } catch (error) {
      if (pgErrorCode(error) !== UNIQUE_VIOLATION) throw error;
      if (attempt >= MAX_CREATE_ATTEMPTS) throw error;
    }
  }
}

/** A key as the dashboard lists it: never its hash. */
export type ApiKeySummary = Omit<ApiKey, "keyHash">;

const summaryColumns = {
  id: apiKeys.id,
  projectId: apiKeys.projectId,
  name: apiKeys.name,
  keyPrefix: apiKeys.keyPrefix,
  scope: apiKeys.scope,
  createdAt: apiKeys.createdAt,
  lastUsedAt: apiKeys.lastUsedAt,
  revokedAt: apiKeys.revokedAt,
};

const toSummary = (record: ApiKey): ApiKeySummary => ({
  id: record.id,
  projectId: record.projectId,
  name: record.name,
  keyPrefix: record.keyPrefix,
  scope: record.scope,
  createdAt: record.createdAt,
  lastUsedAt: record.lastUsedAt,
  revokedAt: record.revokedAt,
});

/**
 * A project's keys, active ones first and newest first within each, for
 * a project in `scope`; none for another organization's project.
 */
export async function listProjectApiKeys(
  db: Pick<Database, "select">,
  scope: OrganizationScope,
  projectId: string,
): Promise<ApiKeySummary[]> {
  if (!isUuid(projectId)) return [];
  return db
    .select(summaryColumns)
    .from(apiKeys)
    .where(
      and(
        eq(apiKeys.projectId, projectId),
        projectInOrganization(apiKeys.projectId, scope),
      ),
    )
    .orderBy(
      sql`${apiKeys.revokedAt} is not null`,
      desc(apiKeys.createdAt),
      asc(apiKeys.id),
    );
}

export type CreateProjectApiKeyResult =
  | { ok: true; key: string; record: ApiKeySummary }
  | { ok: false; error: "not_found" };

/**
 * Creates a key for a project in `scope`, as the dashboard does. The
 * returned `key` is the only copy of the secret.
 */
export async function createProjectApiKey(
  db: Database,
  scope: OrganizationScope,
  {
    projectId,
    name,
    keyScope,
  }: { projectId: string; name: string; keyScope: ApiKeyScope },
): Promise<CreateProjectApiKeyResult> {
  if (!isUuid(projectId)) return { ok: false, error: "not_found" };
  const [project] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), inOrganization(scope)));
  if (!project) return { ok: false, error: "not_found" };
  const { key, record } = await insertKey(db, project.id, name, keyScope);
  return { ok: true, key, record: toSummary(record) };
}

/**
 * Revokes one active key of a project in `scope`, by id. Returns the
 * revoked key, or null if no active key of that project matched.
 */
export async function revokeProjectApiKey(
  db: Pick<Database, "update">,
  scope: OrganizationScope,
  { projectId, keyId }: { projectId: string; keyId: string },
  now: Date = new Date(),
): Promise<ApiKeySummary | null> {
  if (!isUuid(projectId) || !isUuid(keyId)) return null;
  const [revoked] = await db
    .update(apiKeys)
    .set({ revokedAt: now })
    .where(
      and(
        eq(apiKeys.id, keyId),
        eq(apiKeys.projectId, projectId),
        isNull(apiKeys.revokedAt),
        projectInOrganization(apiKeys.projectId, scope),
      ),
    )
    .returning(summaryColumns);
  return revoked ?? null;
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
