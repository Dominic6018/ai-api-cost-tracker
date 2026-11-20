import { USER_ROLES, type UserRole } from "@/db/schema";

export const ROLE_DESCRIPTIONS: Record<UserRole, string> = {
  admin:
    "Everything a member can do, plus API keys, accounts and the audit log.",
  member: "Reads everything and manages projects and budgets.",
  viewer: "Reads everything and changes nothing.",
};

export function parseRole(value: FormDataEntryValue | null): UserRole | null {
  return typeof value === "string" &&
    (USER_ROLES as readonly string[]).includes(value)
    ? (value as UserRole)
    : null;
}

/** What the team page says after a change, from its `status` parameter. */
export const TEAM_STATUS_MESSAGES = {
  changed: { tone: "ok", text: "Role changed." },
  unchanged: { tone: "ok", text: "That account already has that role." },
  last_admin: {
    tone: "error",
    text: "Each organization needs an admin. Make someone else an admin first.",
  },
  not_found: {
    tone: "error",
    text: "That account isn't in your organization.",
  },
  invalid_role: { tone: "error", text: "Choose admin, member or viewer." },
} as const satisfies Record<string, { tone: "ok" | "error"; text: string }>;

export type TeamStatus = keyof typeof TEAM_STATUS_MESSAGES;

export function parseTeamStatus(
  value: string | string[] | undefined,
): TeamStatus | null {
  return typeof value === "string" && Object.hasOwn(TEAM_STATUS_MESSAGES, value)
    ? (value as TeamStatus)
    : null;
}
