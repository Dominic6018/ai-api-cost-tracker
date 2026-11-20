/**
 * What the audit log records and how it reads. Entries hold names and
 * amounts only, never passwords, hashes, API keys or session tokens.
 */

import type { AuditAction, ModelPricing, Project } from "@/db/schema";

export type AuditDetails = Record<string, unknown>;

export interface AuditEntry {
  action: AuditAction;
  /** What changed, by name: a project slug, an email, a key prefix. */
  target: string;
  details?: AuditDetails;
  /**
   * The organization the change concerns, when it isn't the actor's: an
   * account or project changed from the command line.
   */
  organizationId?: string;
}

export const AUDIT_ACTION_LABELS: Record<AuditAction, string> = {
  "project.created": "Created project",
  "project.updated": "Updated project",
  "price.added": "Added price",
  "price.ended": "Ended price",
  "account.created": "Created account",
  "account.role_changed": "Changed role",
  "account.password_reset": "Reset password",
  "account.sessions_revoked": "Signed out everywhere",
  "api_key.created": "Created API key",
  "api_key.revoked": "Revoked API key",
  "organization.created": "Created organization",
  "account.organization_changed": "Moved account",
  "usage.repriced": "Priced usage",
  "billing.customer_created": "Added billing customer",
  "billing.adjusted": "Adjusted billing",
  "billing.reversed": "Reversed billing entry",
  "billing.plan_created": "Added billing plan",
  "billing.subscribed": "Changed billing plan",
  "billing.unsubscribed": "Ended billing plan",
  "billing.charged": "Charged plan month",
  "billing.credit_granted": "Granted credit",
  "billing.credits_applied": "Applied credit",
  "billing.credit_refunded": "Refunded credit",
  "billing.stripe_invoiced": "Invoiced in Stripe",
  "billing.stripe_paid": "Paid through Stripe",
  "account.invited": "Invited account",
  "account.invitation_revoked": "Revoked invitation",
};

const PROJECT_FIELDS = [
  "name",
  "slug",
  "monthlyBudgetUsd",
  "runBudgetUsd",
] as const satisfies ReadonlyArray<keyof Project>;

export function projectCreatedEntry(project: Project): AuditEntry {
  return {
    action: "project.created",
    target: project.slug,
    details: {
      name: project.name,
      monthlyBudgetUsd: project.monthlyBudgetUsd,
      runBudgetUsd: project.runBudgetUsd,
    },
  };
}

/** The fields that differ, or null when saving changed nothing. */
export function projectUpdatedEntry(
  before: Project,
  after: Project,
): AuditEntry | null {
  const details: AuditDetails = {};
  for (const field of PROJECT_FIELDS) {
    if (before[field] !== after[field]) {
      details[field] = { from: before[field], to: after[field] };
    }
  }
  if (Object.keys(details).length === 0) return null;
  return { action: "project.updated", target: after.slug, details };
}

type KeyFields = { keyPrefix: string; name: string; scope: string };

/** A key by its prefix; the key itself is never recorded. */
export function apiKeyCreatedEntry(
  project: Pick<Project, "slug">,
  key: KeyFields,
): AuditEntry {
  return {
    action: "api_key.created",
    target: key.keyPrefix,
    details: { project: project.slug, name: key.name, scope: key.scope },
  };
}

export function apiKeyRevokedEntry(
  project: Pick<Project, "slug">,
  key: KeyFields,
): AuditEntry {
  return {
    action: "api_key.revoked",
    target: key.keyPrefix,
    details: { project: project.slug, name: key.name, scope: key.scope },
  };
}

type InvitationFields = {
  email: string;
  role: string;
  expiresAt: Date;
  invitedByLabel: string;
};

/** An invitation, by the invited email; never its link. */
export function invitedEntry(invitation: InvitationFields): AuditEntry {
  return {
    action: "account.invited",
    target: invitation.email,
    details: {
      role: invitation.role,
      expiresAt: invitation.expiresAt.toISOString(),
    },
  };
}

export function invitationRevokedEntry(
  invitation: InvitationFields,
): AuditEntry {
  return {
    action: "account.invitation_revoked",
    target: invitation.email,
    details: { role: invitation.role },
  };
}

/** The account an accepted invitation made, recorded as by its owner. */
export function invitationAcceptedEntry(
  invitation: InvitationFields,
): AuditEntry {
  return {
    action: "account.created",
    target: invitation.email,
    details: {
      role: invitation.role,
      invitedBy: invitation.invitedByLabel,
    },
  };
}

/** A role change, by the account's email. */
export function roleChangedEntry(change: {
  email: string;
  role: string;
  previousRole: string;
}): AuditEntry | null {
  if (change.role === change.previousRole) return null;
  return {
    action: "account.role_changed",
    target: change.email,
    details: { role: { from: change.previousRole, to: change.role } },
  };
}

const priceTarget = (price: ModelPricing) =>
  `${price.provider} ${price.model} (${price.serviceTier})`;

export function priceAddedEntry(price: ModelPricing): AuditEntry {
  return {
    action: "price.added",
    target: priceTarget(price),
    details: {
      effectiveFrom: price.effectiveFrom.toISOString(),
      inputPerMTokUsd: price.inputPerMTokUsd,
      outputPerMTokUsd: price.outputPerMTokUsd,
      source: price.sourceUrl,
    },
  };
}

export function priceEndedEntry(price: ModelPricing): AuditEntry {
  return {
    action: "price.ended",
    target: priceTarget(price),
    details: {
      endsAt: price.effectiveTo?.toISOString() ?? null,
      source: price.endSourceUrl,
    },
  };
}

const isChange = (value: unknown): value is { from: unknown; to: unknown } =>
  typeof value === "object" &&
  value !== null &&
  "from" in value &&
  "to" in value;

const shown = (value: unknown) =>
  value === null || value === undefined ? "none" : String(value);

/** One line per detail, e.g. "monthlyBudgetUsd: 100.00 → none". */
export function formatAuditDetails(details: AuditDetails | null): string[] {
  return Object.entries(details ?? {}).map(([key, value]) =>
    isChange(value)
      ? `${key}: ${shown(value.from)} → ${shown(value.to)}`
      : `${key}: ${shown(value)}`,
  );
}

export const AUDIT_PAGE_SIZE = 50;
const MAX_AUDIT_PAGE = 1_000_000;

/** A `?page=` value as a page number; anything unusable is the first page. */
export function parseAuditPage(value: string | string[] | undefined): number {
  const page = typeof value === "string" ? Number(value) : NaN;
  return Number.isInteger(page) && page >= 1 && page <= MAX_AUDIT_PAGE
    ? page
    : 1;
}
