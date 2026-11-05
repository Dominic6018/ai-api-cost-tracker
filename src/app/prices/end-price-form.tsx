"use client";

import Link from "next/link";
import { useActionState } from "react";
import {
  EMPTY_END_PRICE_FORM,
  type EndPriceFormState,
} from "@/lib/price-end-form";
import { Field } from "./price-form";

type Action = (
  previous: EndPriceFormState | undefined,
  formData: FormData,
) => Promise<EndPriceFormState>;

export function EndPriceForm({ action }: { action: Action }) {
  const [state, formAction, pending] = useActionState(action, {
    values: EMPTY_END_PRICE_FORM,
    fieldErrors: {},
  });

  return (
    <form
      action={formAction}
      className="flex max-w-2xl flex-col gap-6"
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
        name="endsAt"
        label="Ends at (UTC)"
        hint="Read as UTC. Usage after this has no price for the model."
        state={state}
        inputProps={{ type: "datetime-local" }}
      />
      <fieldset className="grid gap-5 sm:grid-cols-2">
        <legend className="mb-3 text-sm font-medium">Provenance</legend>
        <Field
          name="sourceUrl"
          label="Source"
          hint="Where the end was announced, e.g. the deprecation notice."
          state={state}
          inputProps={{
            type: "url",
            placeholder: "https://…",
            maxLength: 500,
          }}
        />
        <Field
          name="checkedOn"
          label="Checked on"
          hint="The day you checked it there."
          state={state}
          inputProps={{ type: "date" }}
        />
      </fieldset>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-foreground px-4 py-2 font-medium text-background disabled:opacity-60"
        >
          {pending ? "Saving…" : "End price"}
        </button>
        <Link href="/prices" className="text-sm text-foreground/70 underline">
          Cancel
        </Link>
      </div>
    </form>
  );
}
