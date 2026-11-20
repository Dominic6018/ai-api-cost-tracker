import type { Metadata } from "next";
import Link from "next/link";
import { db } from "@/db";
import { findUsableInvitation } from "@/db/invitations";
import { INVALID_INVITATION_MESSAGE } from "@/lib/invitations";
import { MIN_PASSWORD_LENGTH } from "@/lib/passwords";
import { acceptInvitationAction } from "./actions";
import { AcceptForm } from "./accept-form";

export const metadata: Metadata = {
  title: "Accept invitation · AI API Cost Tracker",
  // The link is the credential: keep it out of Referer headers and search.
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/** Public: the link itself is the invitation. */
export default async function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const usable = await findUsableInvitation(db, token);

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-8 px-4 py-12">
      <div className="flex flex-col gap-1">
        <p className="text-sm text-foreground/60">AI API Cost Tracker</p>
        <h1 className="text-3xl font-semibold tracking-tight">
          {usable ? `Join ${usable.organizationName}` : "Invitation"}
        </h1>
      </div>
      {usable ? (
        <>
          <p className="text-sm text-foreground/70">
            {usable.invitation.invitedByLabel} invited{" "}
            <span className="font-medium text-foreground">
              {usable.invitation.email}
            </span>{" "}
            as {usable.invitation.role === "admin" ? "an" : "a"}{" "}
            <span className="font-medium text-foreground">
              {usable.invitation.role}
            </span>
            . Choose a password to create the account; you&apos;ll sign in with
            this email.
          </p>
          <AcceptForm
            action={acceptInvitationAction.bind(null, token)}
            email={usable.invitation.email}
            minLength={MIN_PASSWORD_LENGTH}
          />
        </>
      ) : (
        <>
          <p role="alert" className="text-sm" data-status="invalid">
            {INVALID_INVITATION_MESSAGE}
          </p>
          <Link href="/login" className="text-sm underline">
            Sign in
          </Link>
        </>
      )}
    </main>
  );
}
