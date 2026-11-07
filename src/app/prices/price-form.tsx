"use client";

import Link from "next/link";
import { useActionState } from "react";
import {
  EMPTY_PRICE_FORM,
  PRICE_FORM_TIERS,
  PRICE_PROVIDERS,
  type PriceField,
  type PriceFormState,
} from "@/lib/price-form";

type Action = (
  previous: PriceFormState | undefined,
  formData: FormData,
) => Promise<PriceFormState>;

const inputClass =
  "w-full rounded-md border border-foreground/20 bg-background px-3 py-2 " +
  "text-foreground outline-none focus:border-foreground/60 " +
  "aria-invalid:border-red-600 dark:aria-invalid:border-red-400";

const RATE_PROPS = { inputMode: "decimal", placeholder: "e.g. 3.00" } as const;

export function PriceForm({ action }: { action: Action }) {
  const [state, formAction, pending] = useActionState(action, {
    values: EMPTY_PRICE_FORM,
    fieldErrors: {},
  });
  const field = (
    name: PriceField,
    label: string,
    inputProps: React.InputHTMLAttributes<HTMLInputElement> = {},
    hint?: string,
  ) => (
    <Field
      name={name}
      label={label}
      hint={hint}
      state={state}
      inputProps={inputProps}
    />
  );

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

      <div className="grid gap-5 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="provider" className="text-sm font-medium">
            Provider
          </label>
          <select
            id="provider"
            name="provider"
            key={state.values.provider}
            defaultValue={state.values.provider}
            aria-invalid={state.fieldErrors.provider ? true : undefined}
            aria-describedby={
              state.fieldErrors.provider ? "provider-error" : undefined
            }
            className={inputClass}
          >
            <option value="">Choose…</option>
            {PRICE_PROVIDERS.map((provider) => (
              <option key={provider} value={provider}>
                {provider}
              </option>
            ))}
          </select>
          {state.fieldErrors.provider && (
            <p
              id="provider-error"
              className="text-sm text-red-700 dark:text-red-400"
            >
              {state.fieldErrors.provider}
            </p>
          )}
        </div>
        {field(
          "model",
          "Model",
          { autoComplete: "off", maxLength: 100 },
          "The model ID as the API takes it, e.g. claude-sonnet-5-5.",
        )}
        <div className="flex flex-col gap-1.5">
          <label htmlFor="serviceTier" className="text-sm font-medium">
            Tier
          </label>
          <select
            id="serviceTier"
            name="serviceTier"
            key={state.values.serviceTier}
            defaultValue={state.values.serviceTier}
            aria-invalid={state.fieldErrors.serviceTier ? true : undefined}
            aria-describedby={[
              "serviceTier-hint",
              state.fieldErrors.serviceTier && "serviceTier-error",
            ]
              .filter(Boolean)
              .join(" ")}
            className={inputClass}
          >
            {PRICE_FORM_TIERS.map((tier) => (
              <option key={tier} value={tier}>
                {tier}
              </option>
            ))}
          </select>
          <p id="serviceTier-hint" className="text-xs text-foreground/60">
            Flex and fast (OpenAI&apos;s former priority processing,
            Anthropic&apos;s fast mode) have their own published rates. Batch is
            a multiplier on the standard price, below.
          </p>
          {state.fieldErrors.serviceTier && (
            <p
              id="serviceTier-error"
              className="text-sm text-red-700 dark:text-red-400"
            >
              {state.fieldErrors.serviceTier}
            </p>
          )}
        </div>
      </div>

      <fieldset className="grid gap-5 sm:grid-cols-2">
        <legend className="mb-3 text-sm font-medium">
          Rates (USD per 1M tokens)
        </legend>
        {field("inputPerMTokUsd", "Input", RATE_PROPS)}
        {field("outputPerMTokUsd", "Output", RATE_PROPS)}
        {field(
          "cachedInputPerMTokUsd",
          "Cached input",
          RATE_PROPS,
          "Leave empty if there's no cache discount.",
        )}
        {field(
          "cacheWritePerMTokUsd",
          "Cache write",
          RATE_PROPS,
          "The shortest cache duration (Anthropic: 5 minutes). Leave empty if writes cost the same as input.",
        )}
        {field(
          "cacheWrite1hPerMTokUsd",
          "1-hour cache write",
          RATE_PROPS,
          "Anthropic's 1-hour cache writes. Leave empty if they cost the same as other cache writes.",
        )}
      </fieldset>

      <fieldset className="grid gap-5 sm:grid-cols-2">
        <legend className="mb-3 text-sm font-medium">
          Long-prompt tier (optional)
        </legend>
        {field(
          "longContextThresholdTokens",
          "Over this many input tokens",
          { inputMode: "numeric", placeholder: "e.g. 200000" },
          "Counts cached and cache-write tokens. The whole request pays the long rates.",
        )}
        {field("longInputPerMTokUsd", "Long input", RATE_PROPS)}
        {field("longOutputPerMTokUsd", "Long output", RATE_PROPS)}
        {field("longCachedInputPerMTokUsd", "Long cached input", RATE_PROPS)}
        {field("longCacheWritePerMTokUsd", "Long cache write", RATE_PROPS)}
        {field(
          "longCacheWrite1hPerMTokUsd",
          "Long 1-hour cache write",
          RATE_PROPS,
        )}
      </fieldset>

      <fieldset className="grid gap-5 sm:grid-cols-2">
        <legend className="mb-3 text-sm font-medium">Batch (optional)</legend>
        {field(
          "batchMultiplier",
          "Batch price multiplier",
          { inputMode: "decimal", placeholder: "e.g. 0.5" },
          "The share of the standard price a Batch API request costs, every rate included (Anthropic: 0.5). Leave empty and batch usage for the model is refused.",
        )}
      </fieldset>

      <fieldset className="grid gap-5 sm:grid-cols-2">
        <legend className="mb-3 text-sm font-medium">Audio (optional)</legend>
        <p className="text-sm text-foreground/70 sm:col-span-2">
          For audio and realtime models, which bill audio tokens at their own
          rates. Leave empty and usage with audio tokens is refused for this
          price.
        </p>
        {field("audioInputPerMTokUsd", "Audio input", RATE_PROPS)}
        {field("cachedAudioInputPerMTokUsd", "Cached audio input", RATE_PROPS)}
        {field("audioOutputPerMTokUsd", "Audio output", RATE_PROPS)}
      </fieldset>

      <fieldset className="grid gap-5 sm:grid-cols-2">
        <legend className="mb-3 text-sm font-medium">Images (optional)</legend>
        <p className="text-sm text-foreground/70 sm:col-span-2">
          For image generation models, which bill image tokens at their own
          rates. Any left empty bills image tokens at the matching text rate, as
          vision models do.
        </p>
        {field("imageInputPerMTokUsd", "Image input", RATE_PROPS)}
        {field("cachedImageInputPerMTokUsd", "Cached image input", RATE_PROPS)}
        {field("imageOutputPerMTokUsd", "Image output", RATE_PROPS)}
      </fieldset>

      <fieldset className="grid gap-5 sm:grid-cols-2">
        <legend className="mb-3 text-sm font-medium">
          Web search (optional)
        </legend>
        {field(
          "webSearchPer1kUsd",
          "Web search, per 1,000 searches",
          { inputMode: "decimal", placeholder: "e.g. 10" },
          "Charged on top of tokens for server-side web searches (Anthropic: $10). Leave empty and usage with searches is refused for this price.",
        )}
      </fieldset>

      <fieldset className="grid gap-5 sm:grid-cols-2">
        <legend className="mb-3 text-sm font-medium">Where it applies</legend>
        {field(
          "effectiveFrom",
          "Applies from (UTC)",
          { type: "datetime-local" },
          "Read as UTC. The model's earlier price ends here.",
        )}
      </fieldset>

      <fieldset className="grid gap-5 sm:grid-cols-2">
        <legend className="mb-3 text-sm font-medium">Provenance</legend>
        {field(
          "sourceUrl",
          "Source",
          { type: "url", placeholder: "https://…", maxLength: 500 },
          "The pricing page the rates were copied from.",
        )}
        {field(
          "checkedOn",
          "Checked on",
          { type: "date" },
          "The day you checked the rates there.",
        )}
      </fieldset>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-foreground px-4 py-2 font-medium text-background disabled:opacity-60"
        >
          {pending ? "Saving…" : "Add price"}
        </button>
        <Link href="/prices" className="text-sm text-foreground/70 underline">
          Cancel
        </Link>
      </div>
    </form>
  );
}

/** A labelled input with its hint and inline error, for the price forms. */
export function Field<Name extends string>({
  name,
  label,
  hint,
  state,
  inputProps,
}: {
  name: Name;
  label: string;
  hint?: string;
  state: {
    fieldErrors: Partial<Record<Name, string>>;
    values: Record<Name, string>;
  };
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
