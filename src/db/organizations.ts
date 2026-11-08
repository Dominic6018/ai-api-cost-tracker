import { asc, count, eq } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { normalizeEmail } from "./auth";
import { organizations, projects, users, type Organization } from "./schema";

/** Any Drizzle Postgres database, so the CLI and tests can pass their own. */
type Database = Pick<
  PgDatabase<PgQueryResultHKT>,
  "select" | "insert" | "transaction"
>;

export type CreateOrganizationResult =
  { ok: true; organization: Organization } | { ok: false; error: "slug_taken" };

export async function createOrganization(
  db: Pick<Database, "insert">,
  { name, slug }: { name: string; slug: string },
): Promise<CreateOrganizationResult> {
  const [organization] = await db
    .insert(organizations)
    .values({ name, slug })
    // Not an error, so it can't abort a transaction this is part of.
    .onConflictDoNothing({ target: organizations.slug })
    .returning();
  return organization
    ? { ok: true, organization }
    : { ok: false, error: "slug_taken" };
}

export async function findOrganization(
  db: Pick<Database, "select">,
  slug: string,
): Promise<Organization | undefined> {
  const [organization] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.slug, slug));
  return organization;
}

export interface OrganizationSummary {
  name: string;
  slug: string;
  accounts: number;
  projects: number;
}

/** Every organization, with how many accounts and projects it holds. */
export async function listOrganizations(
  db: Pick<Database, "select">,
): Promise<OrganizationSummary[]> {
  const counts = (table: typeof users | typeof projects) =>
    db
      .select({ id: table.organizationId, n: count() })
      .from(table)
      .groupBy(table.organizationId);
  const [rows, accounts, projectCounts] = await Promise.all([
    db.select().from(organizations).orderBy(asc(organizations.name)),
    counts(users),
    counts(projects),
  ]);
  const accountsIn = new Map(accounts.map((row) => [row.id, row.n]));
  const projectsIn = new Map(projectCounts.map((row) => [row.id, row.n]));
  return rows.map(({ id, name, slug }) => ({
    name,
    slug,
    accounts: accountsIn.get(id) ?? 0,
    projects: projectsIn.get(id) ?? 0,
  }));
}

/**
 * Moves an account to an organization. The organization is read on every
 * request, so it applies straight away, without signing the user out.
 */
export async function setUserOrganization(
  db: Pick<Database, "transaction">,
  {
    email,
    organization,
  }: { email: string; organization: Pick<Organization, "id" | "slug"> },
): Promise<
  | { ok: true; email: string; previous: string; current: string }
  | { ok: false; error: "user_not_found" }
> {
  return db.transaction(async (tx) => {
    const where = eq(users.email, normalizeEmail(email));
    const [before] = await tx
      .select({ slug: organizations.slug })
      .from(users)
      .innerJoin(organizations, eq(organizations.id, users.organizationId))
      .where(where)
      .for("update", { of: users });
    if (!before) return { ok: false, error: "user_not_found" } as const;
    const [user] = await tx
      .update(users)
      .set({ organizationId: organization.id })
      .where(where)
      .returning({ email: users.email });
    return {
      ok: true,
      email: user.email,
      previous: before.slug,
      current: organization.slug,
    } as const;
  });
}
