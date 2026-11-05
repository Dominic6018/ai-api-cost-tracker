import { z } from "zod";

/**
 * The providers a price can be for. Kept here rather than imported from the
 * database schema so the form stays client-safe; a test pins it to
 * `providerEnum`.
 */
export const PRICE_PROVIDERS = [
  "openai",
  "anthropic",
  "google",
  "mistral",
  "other",
] as const;

/** Every field of the add-price form, as submitted. */
export const PRICE_FIELDS = [
  "provider",
  "model",
  "inputPerMTokUsd",
  "outputPerMTokUsd",
  "cachedInputPerMTokUsd",
  "cacheWritePerMTokUsd",
  "cacheWrite1hPerMTokUsd",
  "longContextThresholdTokens",
  "longInputPerMTokUsd",
  "longOutputPerMTokUsd",
  "longCachedInputPerMTokUsd",
  "longCacheWritePerMTokUsd",
  "longCacheWrite1hPerMTokUsd",
  "effectiveFrom",
  "sourceUrl",
  "checkedOn",
] as const;

export type PriceField = (typeof PRICE_FIELDS)[number];

const LONG_FIELDS = [
  "longContextThresholdTokens",
  "longInputPerMTokUsd",
  "longOutputPerMTokUsd",
  "longCachedInputPerMTokUsd",
  "longCacheWritePerMTokUsd",
  "longCacheWrite1hPerMTokUsd",
] as const satisfies readonly PriceField[];

/** Fits `numeric(12, 6)`: up to 6 digits before the point and 6 after. */
const RATE = /^\d{1,6}(\.\d{1,6})?$/;
const RATE_MESSAGE = "Enter a USD amount per 1M tokens, like 3 or 0.075";

const rate = z.string().trim().regex(RATE, RATE_MESSAGE);
const optionalRate = z
  .string()
  .trim()
  .transform((value) => (value === "" ? null : value))
  .refine((value) => value === null || RATE.test(value), RATE_MESSAGE);

const isRealDate = (text: string, date: Date) =>
  !Number.isNaN(date.getTime()) && date.toISOString().startsWith(text);

/** An <input type="datetime-local">, read as UTC. */
export const utcDateTimeField = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "Enter a date and time")
  .transform((value) => ({ value, date: new Date(`${value}:00Z`) }))
  .refine(({ value, date }) => isRealDate(value, date), "Not a real date")
  .transform(({ date }) => date);

/** Where a price change was read: required, http or https. */
export function sourceUrlField(missing: string) {
  return z
    .string()
    .trim()
    .min(1, missing)
    .max(500, "URL must be at most 500 characters")
    .pipe(
      z.url({
        protocol: /^https?$/,
        error: "Enter an http or https URL",
      }),
    );
}

/** The day the source was checked: a real date, not after `now`'s UTC day. */
export function checkedOnField(now: Date) {
  const today = now.toISOString().slice(0, 10);
  return z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Enter the date you checked the source")
    .refine(
      (value) => isRealDate(value, new Date(`${value}T00:00:00Z`)),
      "Not a real date",
    )
    .refine((value) => value <= today, "The check date can't be in the future");
}

/** Builds the form schema; `now` bounds the check date. */
function priceFormSchema(now: Date) {
  return z
    .object({
      provider: z.enum(PRICE_PROVIDERS, { error: "Choose a provider" }),
      model: z
        .string()
        .trim()
        .min(1, "Model is required")
        .max(100, "Model must be at most 100 characters")
        .regex(
          /^[A-Za-z0-9._:/@-]+$/,
          "Use the model ID as the API takes it, e.g. claude-sonnet-5-5",
        ),
      inputPerMTokUsd: rate,
      outputPerMTokUsd: rate,
      cachedInputPerMTokUsd: optionalRate,
      cacheWritePerMTokUsd: optionalRate,
      cacheWrite1hPerMTokUsd: optionalRate,
      longContextThresholdTokens: z
        .string()
        .trim()
        .transform((value) => (value === "" ? null : value))
        .refine(
          (value) => value === null || /^[1-9]\d{0,7}$/.test(value),
          "Enter a whole number of input tokens, e.g. 200000",
        )
        .transform((value) => (value === null ? null : Number(value))),
      longInputPerMTokUsd: optionalRate,
      longOutputPerMTokUsd: optionalRate,
      longCachedInputPerMTokUsd: optionalRate,
      longCacheWritePerMTokUsd: optionalRate,
      longCacheWrite1hPerMTokUsd: optionalRate,
      effectiveFrom: utcDateTimeField,
      sourceUrl: sourceUrlField(
        "Where was this price read? Enter the pricing page's URL",
      ),
      checkedOn: checkedOnField(now),
    })
    .superRefine((values, ctx) => {
      // A tier needs its threshold and both long rates (as the database
      // requires); long cache rates are optional.
      const anyLong = LONG_FIELDS.some((field) => values[field] !== null);
      if (!anyLong) return;
      for (const field of [
        "longContextThresholdTokens",
        "longInputPerMTokUsd",
        "longOutputPerMTokUsd",
      ] as const) {
        if (values[field] === null) {
          ctx.addIssue({
            code: "custom",
            path: [field],
            message: "Required for a long-prompt tier",
          });
        }
      }
    });
}

export type PriceInput = z.infer<ReturnType<typeof priceFormSchema>>;

/** What the form shows after a submission: field errors and the values to refill. */
export interface PriceFormState {
  fieldErrors: Partial<Record<PriceField, string>>;
  formError?: string;
  values: Record<PriceField, string>;
}

export const EMPTY_PRICE_FORM: Record<PriceField, string> = Object.fromEntries(
  PRICE_FIELDS.map((field) => [field, ""]),
) as Record<PriceField, string>;

export type ParsePriceFormResult =
  { ok: true; input: PriceInput } | { ok: false; state: PriceFormState };

/** The form's fields as submitted; missing fields are empty. */
export function readPriceForm(formData: FormData): Record<PriceField, string> {
  return Object.fromEntries(
    PRICE_FIELDS.map((field) => {
      const value = formData.get(field);
      return [field, typeof value === "string" ? value : ""];
    }),
  ) as Record<PriceField, string>;
}

export function parsePriceForm(
  formData: FormData,
  now: Date,
): ParsePriceFormResult {
  const values = readPriceForm(formData);

  const result = priceFormSchema(now).safeParse(values);
  if (result.success) return { ok: true, input: result.data };

  const fieldErrors: PriceFormState["fieldErrors"] = {};
  for (const issue of result.error.issues) {
    const field = issue.path[0] as PriceField | undefined;
    if (field && !fieldErrors[field]) fieldErrors[field] = issue.message;
  }
  return { ok: false, state: { values, fieldErrors } };
}
