import { and, asc, eq, gt, isNull, lte } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { isUuid } from "@/lib/ids";
import {
  generateInvitationToken,
  hashInvitationToken,
  INVITATION_TTL_MS,
  isWellFormedInvitationToken,
} from "@/lib/invitations";
import type { SessionUser } from "./auth";
import {
  accountInvitations,
  organizations,
  users,
  type AccountInvitation,
  type UserRole,
} from "./schema";

/** Any Drizzle Postgres database or transaction. */
type Database = Pick<
  PgDatabase<PgQueryResultHKT>,
  "select" | "insert" | "update"
>;

const pending = and(
  isNull(accountInvitations.acceptedAt),
  isNull(accountInvitations.revokedAt),
);

/** An invitation as the team page lists it: never its token's hash. */
export type InvitationSummary = Omit<AccountInvitation, "tokenHash">;

const summaryColumns = {
  id: accountInvitations.id,
  organizationId: accountInvitations.organizationId,
  email: accountInvitations.email,
  role: accountInvitations.role,
  invitedBy: accountInvitations.invitedBy,
  invitedByLabel: accountInvitations.invitedByLabel,
  createdAt: accountInvitations.createdAt,
  expiresAt: accountInvitations.expiresAt,
  acceptedAt: accountInvitations.acceptedAt,
  acceptedUserId: accountInvitations.acceptedUserId,
  revokedAt: accountInvitations.revokedAt,
};

export type CreateInvitationResult =
  | { ok: true; token: string; invitation: InvitationSummary }
  | { ok: false; error: "unavailable" };

/**
 * Invites an email to an organization with a role. Refused when the email
 * already has an account or a pending invitation, in any organization,
 * since an email signs in to one account. An expired invitation for the
 * email is closed first, so it doesn't stand in the way. Returns the
 * token, the only copy; just its hash is stored.
 */
export async function createInvitation(
  db: Database,
  {
    organizationId,
    email,
    role,
    invitedBy,
  }: {
    organizationId: string;
    email: string;
    role: UserRole;
    invitedBy: Pick<SessionUser, "id" | "email">;
  },
  now: Date = new Date(),
): Promise<CreateInvitationResult> {
  const normalized = email.trim().toLowerCase();
  const [account] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, normalized));
  if (account) return { ok: false, error: "unavailable" };

  await db
    .update(accountInvitations)
    .set({ revokedAt: now })
    .where(
      and(
        eq(accountInvitations.email, normalized),
        pending,
        lte(accountInvitations.expiresAt, now),
      ),
    );

  const { token, hash } = generateInvitationToken();
  const [invitation] = await db
    .insert(accountInvitations)
    .values({
      organizationId,
      email: normalized,
      role,
      tokenHash: hash,
      invitedBy: invitedBy.id,
      invitedByLabel: invitedBy.email,
      createdAt: now,
      expiresAt: new Date(now.getTime() + INVITATION_TTL_MS),
    })
    // A pending invitation for the email already holds the unique index.
    .onConflictDoNothing()
    .returning(summaryColumns);
  return invitation
    ? { ok: true, token, invitation }
    : { ok: false, error: "unavailable" };
}

/** An organization's open invitations, oldest first, expired ones too. */
export async function listPendingInvitations(
  db: Pick<Database, "select">,
  organizationId: string,
): Promise<InvitationSummary[]> {
  return db
    .select(summaryColumns)
    .from(accountInvitations)
    .where(and(eq(accountInvitations.organizationId, organizationId), pending))
    .orderBy(asc(accountInvitations.createdAt), asc(accountInvitations.id));
}

/** Revokes an open invitation of the organization; null if none matched. */
export async function revokeInvitation(
  db: Pick<Database, "update">,
  {
    organizationId,
    invitationId,
  }: { organizationId: string; invitationId: string },
  now: Date = new Date(),
): Promise<InvitationSummary | null> {
  if (!isUuid(invitationId)) return null;
  const [revoked] = await db
    .update(accountInvitations)
    .set({ revokedAt: now })
    .where(
      and(
        eq(accountInvitations.id, invitationId),
        eq(accountInvitations.organizationId, organizationId),
        pending,
      ),
    )
    .returning(summaryColumns);
  return revoked ?? null;
}

export interface UsableInvitation {
  invitation: InvitationSummary;
  organizationName: string;
}

/** The invitation a link opens, if it's open and unexpired; else null. */
export async function findUsableInvitation(
  db: Pick<Database, "select">,
  token: string,
  now: Date = new Date(),
): Promise<UsableInvitation | null> {
  if (!isWellFormedInvitationToken(token)) return null;
  const [row] = await db
    .select({
      invitation: summaryColumns,
      organizationName: organizations.name,
    })
    .from(accountInvitations)
    .innerJoin(
      organizations,
      eq(organizations.id, accountInvitations.organizationId),
    )
    .where(
      and(
        eq(accountInvitations.tokenHash, hashInvitationToken(token)),
        pending,
        gt(accountInvitations.expiresAt, now),
      ),
    );
  return row ?? null;
}

export type AcceptInvitationResult =
  | { ok: true; user: SessionUser; invitation: InvitationSummary }
  | { ok: false; error: "invalid" | "email_taken" };

/**
 * Creates the invited account, with the invitation's email, organization
 * and role, and closes the invitation. Run it in a transaction: the
 * invitation row is locked, so a link used twice at once makes one
 * account. `passwordHash` is hashed by the caller, outside the transaction.
 */
export async function acceptInvitation(
  db: Database,
  { token, passwordHash }: { token: string; passwordHash: string },
  now: Date = new Date(),
): Promise<AcceptInvitationResult> {
  if (!isWellFormedInvitationToken(token)) {
    return { ok: false, error: "invalid" };
  }
  const [invitation] = await db
    .select(summaryColumns)
    .from(accountInvitations)
    .where(
      and(
        eq(accountInvitations.tokenHash, hashInvitationToken(token)),
        pending,
        gt(accountInvitations.expiresAt, now),
      ),
    )
    .for("update");
  if (!invitation) return { ok: false, error: "invalid" };

  const [user] = await db
    .insert(users)
    .values({
      email: invitation.email,
      passwordHash,
      role: invitation.role,
      organizationId: invitation.organizationId,
    })
    .onConflictDoNothing({ target: users.email })
    .returning({
      id: users.id,
      email: users.email,
      role: users.role,
      organizationId: users.organizationId,
    });
  // An account made for the email since, e.g. from the command line.
  if (!user) return { ok: false, error: "email_taken" };

  const [accepted] = await db
    .update(accountInvitations)
    .set({ acceptedAt: now, acceptedUserId: user.id })
    .where(eq(accountInvitations.id, invitation.id))
    .returning(summaryColumns);
  return { ok: true, user, invitation: accepted };
}
