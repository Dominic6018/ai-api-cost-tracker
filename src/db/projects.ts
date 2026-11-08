import { and, asc, eq } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { isUuid } from "@/lib/ids";
import type { ProjectFormValues } from "@/lib/projects";
import { projects, type Project } from "./schema";
import { inOrganization, type OrganizationScope } from "./scope";

/** Any Drizzle Postgres database, so callers and tests can pass their own. */
type Database = Pick<
  PgDatabase<PgQueryResultHKT>,
  "select" | "insert" | "update"
>;

const UNIQUE_VIOLATION = "23505";

function pgErrorCode(error: unknown): string | undefined {
  const cause = (error as { cause?: unknown })?.cause ?? error;
  const code = (cause as { code?: unknown })?.code;
  return typeof code === "string" ? code : undefined;
}

export type SaveProjectResult =
  | { ok: true; project: Project }
  | { ok: false; error: "slug_taken" | "not_found" };

export function listProjects(
  db: Database,
  scope: OrganizationScope,
): Promise<Project[]> {
  return db
    .select()
    .from(projects)
    .where(inOrganization(scope))
    .orderBy(asc(projects.name));
}

/** Returns undefined for unknown or malformed ids. */
export async function getProject(
  db: Database,
  scope: OrganizationScope,
  id: string,
): Promise<Project | undefined> {
  if (!isUuid(id)) return undefined;
  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, id), inOrganization(scope)));
  return project;
}

// Saves run in their own transaction, a savepoint inside a caller's. A
// duplicate slug fails the statement, and that must not abort the caller's
// transaction: the driver would rethrow it even after it's been handled.
export async function createProject<
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
>(
  // Generic, so both the app's schema-aware database and plain ones fit.
  db: Pick<PgDatabase<TQueryResult, TFullSchema>, "transaction">,
  values: ProjectFormValues & { organizationId?: string },
): Promise<SaveProjectResult> {
  try {
    const [project] = await db.transaction((tx) =>
      tx.insert(projects).values(values).returning(),
    );
    return { ok: true, project };
  } catch (error) {
    if (pgErrorCode(error) === UNIQUE_VIOLATION) {
      return { ok: false, error: "slug_taken" };
    }
    throw error;
  }
}

export async function updateProject<
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
>(
  db: Pick<PgDatabase<TQueryResult, TFullSchema>, "transaction">,
  scope: OrganizationScope,
  id: string,
  values: ProjectFormValues,
): Promise<SaveProjectResult> {
  if (!isUuid(id)) return { ok: false, error: "not_found" };
  try {
    const [project] = await db.transaction((tx) =>
      tx
        .update(projects)
        .set(values)
        .where(and(eq(projects.id, id), inOrganization(scope)))
        .returning(),
    );
    return project ? { ok: true, project } : { ok: false, error: "not_found" };
  } catch (error) {
    if (pgErrorCode(error) === UNIQUE_VIOLATION) {
      return { ok: false, error: "slug_taken" };
    }
    throw error;
  }
}
