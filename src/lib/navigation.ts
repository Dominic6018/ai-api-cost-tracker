/**
 * The dashboard's sections and their pages, for the navigation bar. A
 * section shows only if the account may see at least one of its pages.
 */

import type { UserRole } from "@/db/schema";
import { can, type Permission } from "./roles";

export interface NavLink {
  href: string;
  label: string;
  /** Shown only to accounts with this permission. */
  permission?: Permission;
}

export interface NavSection {
  label: string;
  links: NavLink[];
}

export const NAV_SECTIONS: NavSection[] = [
  { label: "Overview", links: [{ href: "/overview", label: "Overview" }] },
  {
    label: "Usage",
    links: [
      { href: "/usage", label: "Events" },
      { href: "/spend", label: "Over time" },
      { href: "/breakdown", label: "Breakdown" },
    ],
  },
  {
    label: "Insights",
    links: [
      { href: "/changes", label: "Why spend changed" },
      { href: "/savings", label: "Savings estimates" },
    ],
  },
  {
    label: "Customers",
    links: [
      { href: "/revenue", label: "Revenue" },
      {
        href: "/revenue/portal",
        label: "Portal links",
        permission: "portal:manage",
      },
    ],
  },
  {
    label: "Budgets",
    links: [{ href: "/projects", label: "Projects and budgets" }],
  },
  { label: "Prices", links: [{ href: "/prices", label: "Prices" }] },
  {
    label: "Integrations",
    links: [{ href: "/ingestion", label: "Ingestion health" }],
  },
  {
    label: "Team",
    links: [
      { href: "/team", label: "Accounts", permission: "team:manage" },
      { href: "/audit", label: "Audit log", permission: "audit:read" },
    ],
  },
];

/**
 * The sections an account sees, each with the pages it may open, and
 * which one holds `current` (a page's path, e.g. "/spend").
 */
export function navigationFor(
  user: { role: UserRole; organizationId: string },
  current: string,
): Array<NavSection & { active: boolean }> {
  return NAV_SECTIONS.map((section) => ({
    ...section,
    links: section.links.filter(
      (link) => !link.permission || can(user, link.permission),
    ),
  }))
    .filter((section) => section.links.length > 0)
    .map((section) => ({
      ...section,
      active: section.links.some((link) => link.href === current),
    }));
}
