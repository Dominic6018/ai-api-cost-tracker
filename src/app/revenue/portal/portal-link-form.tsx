"use client";

import { useActionState } from "react";
import type { PortalLinkFormState } from "./actions";

type Action = (
  previous: PortalLinkFormState | undefined,
  formData: FormData,
) => Promise<PortalLinkFormState>;

const utcDate = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  year: "numeric",
  month: "short",
  day: "numeric",
});

export function PortalLinkForm({
  action,
  customers,
}: {
  action: Action;
  customers: Array<{ id: string; label: string }>;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const { created } = state;

  return (
    <div className="flex flex-col gap-4">
      {created && (
        <section
          role="status"
          aria-labelledby="portal-link-heading"
          className="flex flex-col gap-3 rounded-lg border border-green-700/40 p-4"
        >
          <h3 id="portal-link-heading" className="font-semibold">
            Portal link for {created.customer}
          </h3>
          <p className="text-sm">
            Send it to the customer yourself. Anyone with it can read their
            statement until {utcDate.format(new Date(created.expiresAt))}, and
            it can&apos;t be shown again.
          </p>
          <label htmlFor="portal-link" className="sr-only">
            Portal link
          </label>
          <input
            id="portal-link"
            readOnly
            value={created.url}
            onFocus={(event) => event.currentTarget.select()}
            className="w-full rounded-md border border-foreground/20 bg-background px-3 py-2 font-mono text-sm"
          />
        </section>
      )}
      <form action={formAction} className="flex flex-wrap items-end gap-3">
        <div className="flex min-w-64 flex-1 flex-col gap-1.5">
          <label htmlFor="customerId" className="text-sm font-medium">
            Customer
          </label>
          <select
            id="customerId"
            name="customerId"
            required
            className="rounded-md border border-foreground/20 bg-background px-3 py-2"
          >
            {customers.map((customer) => (
              <option key={customer.id} value={customer.id}>
                {customer.label}
              </option>
            ))}
          </select>
        </div>
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-foreground px-4 py-2 font-medium text-background disabled:opacity-60"
        >
          {pending ? "Creating…" : "Create portal link"}
        </button>
        {state.error && (
          <p
            role="alert"
            className="w-full text-sm text-red-700 dark:text-red-400"
          >
            {state.error}
          </p>
        )}
      </form>
    </div>
  );
}
