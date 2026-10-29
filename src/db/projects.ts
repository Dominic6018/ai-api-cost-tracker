import { asc, eq } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { ProjectFormValues } from "@/lib/projects";
import { projects, type Project } from "./schema";

/** Any Drizzle Postgres database, so callers and tests can pass their own. */
type Database = Pick<
  PgDatabase<PgQueryResultHKT>,
  "select" | "insert" | "update"
>;

const UNIQUE_VIOLATION = "23505";
const INVALID_TEXT_REPRESENTATION = "22P02";

function pgErrorCode(error: unknown): string | undefined {
  const cause = (error as { cause?: unknown })?.cause ?? error;
  const code = (cause as { code?: unknown })?.code;
  return typeof code === "string" ? code : undefined;
}

export type SaveProjectResult =
  | { ok: true; project: Project }
  | { ok: false; error: "slug_taken" | "not_found" };

export function listProjects(db: Database): Promise<Project[]> {
  return db.select().from(projects).orderBy(asc(projects.name));
}

/** Returns undefined for unknown or malformed ids. */
export async function getProject(
  db: Database,
  id: string,
): Promise<Project | undefined> {
  try {
    const [project] = await db
      .select()
      .from(projects)
      .where(eq(projects.id, id));
    return project;
  } catch (error) {
    if (pgErrorCode(error) === INVALID_TEXT_REPRESENTATION) return undefined;
    throw error;
  }
}

export async function createProject(
  db: Database,
  values: ProjectFormValues,
): Promise<SaveProjectResult> {
  try {
    const [project] = await db.insert(projects).values(values).returning();
    return { ok: true, project };
  } catch (error) {
    if (pgErrorCode(error) === UNIQUE_VIOLATION) {
      return { ok: false, error: "slug_taken" };
    }
    throw error;
  }
}

export async function updateProject(
  db: Database,
  id: string,
  values: ProjectFormValues,
): Promise<SaveProjectResult> {
  try {
    const [project] = await db
      .update(projects)
      .set(values)
      .where(eq(projects.id, id))
      .returning();
    return project ? { ok: true, project } : { ok: false, error: "not_found" };
  } catch (error) {
    const code = pgErrorCode(error);
    if (code === UNIQUE_VIOLATION) return { ok: false, error: "slug_taken" };
    if (code === INVALID_TEXT_REPRESENTATION) {
      return { ok: false, error: "not_found" };
    }
    throw error;
  }
}
