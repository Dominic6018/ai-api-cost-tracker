"use client";

import Link from "next/link";
import { useActionState } from "react";
import type { ProjectFormState, ProjectFormValues } from "@/lib/projects";

type Action = (
  previous: ProjectFormState | undefined,
  formData: FormData,
) => Promise<ProjectFormState>;

interface ProjectFormProps {
  action: Action;
  initialValues?: ProjectFormState["values"];
  submitLabel: string;
}

const EMPTY = { name: "", slug: "", monthlyBudgetUsd: "" };

const inputClass =
  "w-full rounded-md border border-foreground/20 bg-background px-3 py-2 " +
  "text-foreground outline-none focus:border-foreground/60 " +
  "aria-invalid:border-red-600 dark:aria-invalid:border-red-400";

export function ProjectForm({
  action,
  initialValues = EMPTY,
  submitLabel,
}: ProjectFormProps) {
  const [state, formAction, pending] = useActionState(action, {
    values: initialValues,
    fieldErrors: {},
  });

  return (
    <form
      action={formAction}
      className="flex max-w-lg flex-col gap-5"
      noValidate
    >
      {state.formError && (
        <p
          role="alert"
          className="rounded-md border border-red-600/40 px-3 py-2 text-sm text-red-700 dark:text-red-400"
        >
          {state.formError}
        </p>
      )}

      <Field
        name="name"
        label="Name"
        state={state}
        inputProps={{ autoComplete: "off", required: true, maxLength: 100 }}
      />
      <Field
        name="slug"
        label="Slug"
        hint="Lowercase letters, numbers and hyphens. Must be unique."
        state={state}
        inputProps={{ autoComplete: "off", required: true, maxLength: 64 }}
      />
      <Field
        name="monthlyBudgetUsd"
        label="Monthly budget (USD)"
        hint="Leave empty for no budget."
        state={state}
        inputProps={{ inputMode: "decimal", placeholder: "e.g. 100.00" }}
      />

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-foreground px-4 py-2 font-medium text-background disabled:opacity-60"
        >
          {pending ? "Saving…" : submitLabel}
        </button>
        <Link href="/projects" className="text-sm text-foreground/70 underline">
          Cancel
        </Link>
      </div>
    </form>
  );
}

function Field({
  name,
  label,
  hint,
  state,
  inputProps,
}: {
  name: keyof ProjectFormValues;
  label: string;
  hint?: string;
  state: ProjectFormState;
  inputProps: React.InputHTMLAttributes<HTMLInputElement>;
}) {
  const error = state.fieldErrors[name];
  const describedBy = [hint && `${name}-hint`, error && `${name}-error`]
    .filter(Boolean)
    .join(" ");

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={name} className="text-sm font-medium">
        {label}
      </label>
      <input
        id={name}
        name={name}
        // Re-mount with the submitted value after a failed save.
        key={state.values[name]}
        defaultValue={state.values[name]}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
        className={inputClass}
        {...inputProps}
      />
      {hint && (
        <p id={`${name}-hint`} className="text-xs text-foreground/60">
          {hint}
        </p>
      )}
      {error && (
        <p
          id={`${name}-error`}
          className="text-sm text-red-700 dark:text-red-400"
        >
          {error}
        </p>
      )}
    </div>
  );
}
