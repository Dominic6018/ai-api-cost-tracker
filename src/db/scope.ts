import { eq, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { auditLog, projects } from "./schema";

/**
 * Whose data a query may read. It's a required argument, so leaving it out
 * is a compile error rather than a leak between organizations.
 */
export type OrganizationScope =
  { organizationId: string } | typeof ALL_ORGANIZATIONS;

/**
 * For code that isn't acting for a signed-in account: scheduled jobs, the
 * command line, and API keys, which are limited to one project already.
 */
export const ALL_ORGANIZATIONS = { allOrganizations: true } as const;

export const organizationScope = (user: {
  organizationId: string;
}): OrganizationScope => ({ organizationId: user.organizationId });

/** A condition for queries that read `projects`. */
export function inOrganization(scope: OrganizationScope): SQL | undefined {
  return "organizationId" in scope
    ? eq(projects.organizationId, scope.organizationId)
    : undefined;
}

/** A condition for the audit log, which has its own organization. */
export function auditInOrganization(scope: OrganizationScope): SQL | undefined {
  return "organizationId" in scope
    ? eq(auditLog.organizationId, scope.organizationId)
    : undefined;
}

/** A condition for tables that only have a project id. */
export function projectInOrganization(
  column: AnyPgColumn,
  scope: OrganizationScope,
): SQL | undefined {
  return "organizationId" in scope
    ? sql`${column} in (select ${projects.id} from ${projects} where ${projects.organizationId} = ${scope.organizationId})`
    : undefined;
}
