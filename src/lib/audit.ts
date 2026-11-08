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
