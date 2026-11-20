"use client";

import { useActionState } from "react";
import {
  API_KEY_SCOPE_LABELS,
  EMPTY_API_KEY_FORM,
  MAX_API_KEY_NAME_LENGTH,
  type ApiKeyFormState,
} from "@/lib/api-key-form";

type Action = (
  previous: ApiKeyFormState | undefined,
  formData: FormData,
) => Promise<ApiKeyFormState>;

const inputClass =
  "w-full rounded-md border border-foreground/20 bg-background px-3 py-2 " +
  "text-foreground outline-none focus:border-foreground/60 " +
  "aria-invalid:border-red-600 dark:aria-invalid:border-red-400";

const SCOPE_HINTS = {
  ingest: "For your app: sends usage, outcomes and traces. Can't read costs.",
  read: "For reporting tools: reads cost reports. Can't send anything.",
} as const;

export function ApiKeyForm({ action }: { action: Action }) {
  const [state, formAction, pending] = useActionState(
    action,
    EMPTY_API_KEY_FORM,
  );
  const { created } = state;
  const nameError = state.fieldErrors.name;
  const scopeError = state.fieldErrors.scope;
  // Re-mount the inputs after each submission, so they show its values.
  const round = `${state.values.name}|${state.values.scope}|${created?.prefix ?? ""}`;

  return (
    <div className="flex flex-col gap-6">
      {created && (
        <section
          role="status"
          aria-labelledby="created-key-heading"
          className="flex flex-col gap-3 rounded-lg border border-green-700/40 p-4"
        >
          <h2 id="created-key-heading" className="font-semibold">
            Created key &ldquo;{created.name}&rdquo;
          </h2>
          <p className="text-sm">
            Copy it now and store it as a secret. It isn&apos;t stored here and
            can&apos;t be shown again; if it&apos;s lost, create another and
            revoke this one.
          </p>
          <label htmlFor="created-key" className="sr-only">
            New API key
          </label>
          <input
            id="created-key"
            readOnly
            value={created.key}
            onFocus={(event) => event.currentTarget.select()}
            className={`${inputClass} font-mono text-sm`}
          />
          <p className="text-xs text-foreground/60">
            {API_KEY_SCOPE_LABELS[created.scope]}. Set it as{" "}
            <code className="font-mono">
              {created.scope === "read"
                ? "COST_TRACKER_READ_KEY"
                : "COST_TRACKER_API_KEY"}
            </code>{" "}
            where your code runs. It&apos;s listed below by its prefix,{" "}
            <span className="font-mono">{created.prefix}</span>.
          </p>
        </section>
      )}

      <form
        action={formAction}
        className="flex max-w-lg flex-col gap-5"
        noValidate
      >
        <h2 className="text-lg font-semibold">New API key</h2>
        {state.formError && (
          <p
            role="alert"
            className="rounded-md border border-red-600/40 px-3 py-2 text-sm text-red-700 dark:text-red-400"
          >
            {state.formError}
          </p>
        )}
        <div className="flex flex-col gap-1.5">
          <label htmlFor="name" className="text-sm font-medium">
            Name
          </label>
          <input
            id="name"
            name="name"
            key={`name|${round}`}
            defaultValue={state.values.name}
            autoComplete="off"
            required
            maxLength={MAX_API_KEY_NAME_LENGTH}
            placeholder="e.g. production"
            aria-invalid={nameError ? true : undefined}
            aria-describedby={nameError ? "name-hint name-error" : "name-hint"}
            className={inputClass}
          />
          <p id="name-hint" className="text-xs text-foreground/60">
            Where the key is used, so you know which one to revoke.
          </p>
          {nameError && (
            <p
              id="name-error"
              className="text-sm text-red-700 dark:text-red-400"
            >
              {nameError}
            </p>
          )}
        </div>
        <fieldset
          className="flex flex-col gap-2"
          aria-describedby={scopeError ? "scope-error" : undefined}
        >
          <legend className="mb-1 text-sm font-medium">What it may do</legend>
          {(["ingest", "read"] as const).map((scope) => (
            <label key={scope} className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name="scope"
                value={scope}
                key={`${scope}|${round}`}
                defaultChecked={state.values.scope === scope}
                className="mt-1"
              />
              <span>
                <span className="font-medium">
                  {API_KEY_SCOPE_LABELS[scope]}
                </span>
                <span className="block text-foreground/60">
                  {SCOPE_HINTS[scope]}
                </span>
              </span>
            </label>
          ))}
          {scopeError && (
            <p
              id="scope-error"
              className="text-sm text-red-700 dark:text-red-400"
            >
              {scopeError}
            </p>
          )}
        </fieldset>
        <div>
          <button
            type="submit"
            disabled={pending}
            className="rounded-md bg-foreground px-4 py-2 font-medium text-background disabled:opacity-60"
          >
            {pending ? "Creating…" : "Create key"}
          </button>
        </div>
      </form>
    </div>
  );
}
