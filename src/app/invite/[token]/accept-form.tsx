"use client";

import { useActionState } from "react";
import type { AcceptFormState } from "@/lib/invitations";

type Action = (
  previous: AcceptFormState | undefined,
  formData: FormData,
) => Promise<AcceptFormState>;

const inputClass =
  "w-full rounded-md border border-foreground/20 bg-background px-3 py-2 " +
  "text-foreground outline-none focus:border-foreground/60";

export function AcceptForm({
  action,
  email,
  minLength,
}: {
  action: Action;
  email: string;
  minLength: number;
}) {
  const [state, formAction, pending] = useActionState(action, {});

  return (
    <form action={formAction} className="flex flex-col gap-4">
      {state.error && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {state.error}
        </p>
      )}
      {/* For password managers: the account this password belongs to. */}
      <input
        type="email"
        name="username"
        value={email}
        autoComplete="username"
        readOnly
        hidden
      />
      <div className="flex flex-col gap-1.5">
        <label htmlFor="password" className="text-sm font-medium">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={minLength}
          aria-describedby="password-hint"
          className={inputClass}
        />
        <p id="password-hint" className="text-xs text-foreground/60">
          At least {minLength} characters.
        </p>
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="confirmPassword" className="text-sm font-medium">
          Password again
        </label>
        <input
          id="confirmPassword"
          name="confirmPassword"
          type="password"
          autoComplete="new-password"
          required
          className={inputClass}
        />
      </div>
      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-foreground px-4 py-2 font-medium text-background disabled:opacity-60"
      >
        {pending ? "Creating your account…" : "Create account and sign in"}
      </button>
    </form>
  );
}
