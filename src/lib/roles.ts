/**
 * What each account role may change. Every role can read the dashboard.
 * Prices are limited to admins because a wrong price makes every number
 * wrong.
 */

import type { UserRole } from "@/db/schema";

const ALLOWED_ROLES = {
  "projects:manage": ["admin", "member"],
  "prices:manage": ["admin"],
  "audit:read": ["admin"],
} as const satisfies Record<string, readonly UserRole[]>;

export type Permission = keyof typeof ALLOWED_ROLES;

export function can(role: UserRole, permission: Permission): boolean {
  return (ALLOWED_ROLES[permission] as readonly UserRole[]).includes(role);
}
