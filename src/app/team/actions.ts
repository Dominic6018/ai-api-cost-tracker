"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { changeAccountRole } from "@/db/accounts";
import { audited, userActor } from "@/db/audit";
import { createInvitation, revokeInvitation } from "@/db/invitations";
import {
  invitationRevokedEntry,
  invitedEntry,
  roleChangedEntry,
} from "@/lib/audit";
import { requirePermission } from "@/lib/auth";
import {
  EMPTY_INVITE_FORM,
  invitationUrl,
  parseInviteForm,
  type InviteFormState,
} from "@/lib/invitations";
import { parseRole, type TeamStatus } from "@/lib/team";

// Server actions can be called from any route, so this checks the session
// and role itself, and changes only accounts in the admin's organization.
export async function changeRoleAction(
  userId: string,
  formData: FormData,
): Promise<void> {
  const user = await requirePermission("team:manage");
  const role = parseRole(formData.get("role"));
  let status: TeamStatus = "invalid_role";
  if (role) {
    const result = await audited(db, userActor(user), async (tx) => {
      const changed = await changeAccountRole(tx, {
        organizationId: user.organizationId,
        userId,
        role,
      });
      return {
        result: changed,
        entry: changed.ok ? roleChangedEntry(changed) : null,
      };
    });
    status = !result.ok
      ? result.error
      : result.previousRole === result.role
        ? "unchanged"
        : "changed";
  }
  revalidatePath("/team");
  // An admin who made themselves a member is sent on to /no-access.
  redirect(`/team?status=${status}`);
}

/** Invites an email to the admin's organization; shows the link once. */
export async function inviteAction(
  _previous: InviteFormState | undefined,
  formData: FormData,
): Promise<InviteFormState> {
  const user = await requirePermission("team:manage");
  const parsed = parseInviteForm(formData);
  if (!parsed.ok) return parsed.state;

  const result = await audited(db, userActor(user), async (tx) => {
    const created = await createInvitation(tx, {
      organizationId: user.organizationId,
      email: parsed.values.email,
      role: parsed.values.role,
      invitedBy: user,
    });
    return {
      result: created,
      entry: created.ok ? invitedEntry(created.invitation) : null,
    };
  });
  if (!result.ok) {
    return {
      values: parsed.values,
      fieldErrors: {
        email:
          "This email already has an account or an invitation waiting. Each email has one account.",
      },
    };
  }
  revalidatePath("/team");
  const request = await headers();
  return {
    ...EMPTY_INVITE_FORM,
    created: {
      email: result.invitation.email,
      role: result.invitation.role,
      url: invitationUrl(result.token, {
        host: request.get("x-forwarded-host") ?? request.get("host"),
        proto: request.get("x-forwarded-proto"),
      }),
      expiresAt: result.invitation.expiresAt.toISOString(),
    },
  };
}

/** Revokes an open invitation of the admin's organization. */
export async function revokeInvitationAction(
  invitationId: string,
): Promise<void> {
  const user = await requirePermission("team:manage");
  const revoked = await audited(db, userActor(user), async (tx) => {
    const done = await revokeInvitation(tx, {
      organizationId: user.organizationId,
      invitationId,
    });
    return {
      result: done,
      entry: done ? invitationRevokedEntry(done) : null,
    };
  });
  revalidatePath("/team");
  redirect(
    `/team?status=${revoked ? "invitation_revoked" : "invitation_not_found"}`,
  );
}
