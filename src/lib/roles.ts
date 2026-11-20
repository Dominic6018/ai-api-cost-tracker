/**
 * What each account role may change. Every role can read the dashboard.
 * Prices are limited to admins because a wrong price makes every number
 * wrong. Prices are shared by the whole install, so only the install's
 * owners, the admins of the default organization, may change them.
 */

import { DEFAULT_ORGANIZATION_ID, type UserRole } from "@/db/schema";

const ALLOWED_ROLES = {
  "projects:manage": ["admin", "member"],
  "prices:manage": ["admin"],
  "audit:read": ["admin"],
  // A key outlives the account that made it, and a read key opens cost
  // data to any tool holding it, so only admins make or revoke them.
  "api_keys:manage": ["admin"],
  // Who is in the organization and what they may do.
  "team:manage": ["admin"],
} as const satisfies Record<string, readonly UserRole[]>;

export type Permission = keyof typeof ALLOWED_ROLES;

const INSTALL_WIDE: ReadonlySet<Permission> = new Set(["prices:manage"]);

export function can(
  user: { role: UserRole; organizationId: string },
  permission: Permission,
): boolean {
  const roleAllowed = (
    ALLOWED_ROLES[permission] as readonly UserRole[]
  ).includes(user.role);
  return (
    roleAllowed &&
    (!INSTALL_WIDE.has(permission) ||
      user.organizationId === DEFAULT_ORGANIZATION_ID)
  );
}
