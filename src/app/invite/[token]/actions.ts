"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { audited } from "@/db/audit";
import { createSession } from "@/db/auth";
import { acceptInvitation, findUsableInvitation } from "@/db/invitations";
import { invitationAcceptedEntry } from "@/lib/audit";
import {
  INVALID_INVITATION_MESSAGE,
  parseAcceptForm,
  type AcceptFormState,
} from "@/lib/invitations";
import { hashPassword } from "@/lib/passwords";
import { SESSION_COOKIE } from "@/lib/sessions";

/**
 * Makes the invited account and signs it in. The link's token is the
 * only credential, so it's checked before the slow password hash, and
 * again, locked, in the transaction that uses it up.
 */
export async function acceptInvitationAction(
  token: string,
  _previous: AcceptFormState | undefined,
  formData: FormData,
): Promise<AcceptFormState> {
  const parsed = parseAcceptForm(formData);
  if (!parsed.ok) return parsed.state;

  const usable = await findUsableInvitation(db, token);
  if (!usable) return { error: INVALID_INVITATION_MESSAGE };
  const passwordHash = await hashPassword(parsed.password);

  const { invitation } = usable;
  const actor = {
    userId: null,
    label: invitation.email,
    organizationId: invitation.organizationId,
  };
  const result = await audited(db, actor, async (tx) => {
    const accepted = await acceptInvitation(tx, { token, passwordHash });
    return {
      result: accepted,
      entry: accepted.ok ? invitationAcceptedEntry(accepted.invitation) : null,
    };
  });
  if (!result.ok) {
    return {
      error:
        result.error === "email_taken"
          ? "An account already exists for this email. Sign in instead."
          : INVALID_INVITATION_MESSAGE,
    };
  }

  const { token: session, expiresAt } = await createSession(db, result.user.id);
  (await cookies()).set(SESSION_COOKIE, session, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
  redirect("/overview");
}
