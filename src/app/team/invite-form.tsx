"use client";

import { useActionState } from "react";
import { USER_ROLES } from "@/db/schema";
import { EMPTY_INVITE_FORM, type InviteFormState } from "@/lib/invitations";

type Action = (
  previous: InviteFormState | undefined,
  formData: FormData,
) => Promise<InviteFormState>;

const inputClass =
  "w-full rounded-md border border-foreground/20 bg-background px-3 py-2 " +
  "text-foreground outline-none focus:border-foreground/60 " +
  "aria-invalid:border-red-600 dark:aria-invalid:border-red-400";

const utcDateTime = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export function InviteForm({ action }: { action: Action }) {
  const [state, formAction, pending] = useActionState(
    action,
    EMPTY_INVITE_FORM,
  );
  const { created } = state;
  const emailError = state.fieldErrors.email;
  // Re-mount the inputs after each submission, so they show its values.
  const round = `${state.values.email}|${state.values.role}|${created?.url ?? ""}`;

  return (
    <div className="flex flex-col gap-4">
      {created && (
        <section
          role="status"
          aria-labelledby="invitation-heading"
          className="flex flex-col gap-3 rounded-lg border border-green-700/40 p-4"
        >
          <h3 id="invitation-heading" className="font-semibold">
            Invited {created.email} as {created.role}
          </h3>
          <p className="text-sm">
            Send them this link yourself; it isn&apos;t emailed. It works once,
            until {utcDateTime.format(new Date(created.expiresAt))} UTC, and
            can&apos;t be shown again. Anyone with the link can use it, so send
            it only to them.
          </p>
          <label htmlFor="invitation-link" className="sr-only">
            Invitation link
          </label>
          <input
            id="invitation-link"
            readOnly
            value={created.url}
            onFocus={(event) => event.currentTarget.select()}
            className={`${inputClass} font-mono text-sm`}
          />
        </section>
      )}

      <form
        action={formAction}
        className="flex flex-wrap items-end gap-3"
        noValidate
      >
        <div className="flex min-w-64 flex-1 flex-col gap-1.5">
          <label htmlFor="invite-email" className="text-sm font-medium">
            Email
          </label>
          <input
            id="invite-email"
            name="email"
            type="email"
            key={`email|${round}`}
            defaultValue={state.values.email}
            autoComplete="off"
            required
            maxLength={254}
            aria-invalid={emailError ? true : undefined}
            aria-describedby={emailError ? "invite-email-error" : undefined}
            className={inputClass}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="invite-role" className="text-sm font-medium">
            Role
          </label>
          <select
            id="invite-role"
            name="role"
            key={`role|${round}`}
            defaultValue={state.values.role}
            className="rounded-md border border-foreground/20 bg-background px-3 py-2"
          >
            {USER_ROLES.map((role) => (
              <option key={role} value={role}>
                {role}
              </option>
            ))}
          </select>
        </div>
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-foreground px-4 py-2 font-medium text-background disabled:opacity-60"
        >
          {pending ? "Inviting…" : "Create invitation link"}
        </button>
        {emailError && (
          <p
            id="invite-email-error"
            className="w-full text-sm text-red-700 dark:text-red-400"
          >
            {emailError}
          </p>
        )}
      </form>
    </div>
  );
}
