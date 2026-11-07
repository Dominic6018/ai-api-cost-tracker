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

/** The tiers a price can be for, pinned to `PRICE_TIERS` by a test. */
export const PRICE_FORM_TIERS = ["standard", "flex", "fast"] as const;

/** Every field of the add-price form, as submitted. */
export const PRICE_FIELDS = [
  "provider",
  "model",
  "serviceTier",
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
  "batchMultiplier",
  "webSearchPer1kUsd",
  "audioInputPerMTokUsd",
  "cachedAudioInputPerMTokUsd",
  "audioOutputPerMTokUsd",
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

/** USD per 1,000 web searches, also within `numeric(12, 6)`; empty means none. */
const SEARCH_MESSAGE = "Enter a USD amount per 1,000 searches, like 10";
const optionalSearchRate = z
  .string()
  .trim()
  .transform((value) => (value === "" ? null : value))
  .refine((value) => value === null || RATE.test(value), SEARCH_MESSAGE);

/**
 * The share of the standard price a batch request costs: more than 0, at
 * most 1, up to 3 decimals (fits `numeric(4, 3)`). Empty means batch usage
 * isn't priced and is refused.
 */
const batchMultiplier = z
  .string()
  .trim()
  .transform((value) => (value === "" ? null : value))
  .refine(
    (value) =>
      value === null ||
      (/^[01](\.\d{1,3})?$/.test(value) &&
        Number(value) > 0 &&
        Number(value) <= 1),
    "Enter the share of the standard price, more than 0 and at most 1, e.g. 0.5",
  );

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
      serviceTier: z.enum(PRICE_FORM_TIERS, { error: "Choose a tier" }),
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
      batchMultiplier,
      webSearchPer1kUsd: optionalSearchRate,
      audioInputPerMTokUsd: optionalRate,
      cachedAudioInputPerMTokUsd: optionalRate,
      audioOutputPerMTokUsd: optionalRate,
      effectiveFrom: utcDateTimeField,
      sourceUrl: sourceUrlField(
        "Where was this price read? Enter the pricing page's URL",
      ),
      checkedOn: checkedOnField(now),
    })
    .superRefine((values, ctx) => {
      // Batch is a discount on the standard price (as the database requires).
      if (
        values.batchMultiplier !== null &&
        values.serviceTier !== "standard"
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["batchMultiplier"],
          message: "Only standard prices have a batch price",
        });
      }
      // Audio needs both its input and output rates (as the database
      // requires); the cached audio rate is optional.
      const anyAudio =
        values.audioInputPerMTokUsd !== null ||
        values.audioOutputPerMTokUsd !== null ||
        values.cachedAudioInputPerMTokUsd !== null;
      if (anyAudio) {
        for (const field of [
          "audioInputPerMTokUsd",
          "audioOutputPerMTokUsd",
        ] as const) {
          if (values[field] === null) {
            ctx.addIssue({
              code: "custom",
              path: [field],
              message: "Required for audio pricing",
            });
          }
        }
      }
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

export const EMPTY_PRICE_FORM: Record<PriceField, string> = {
  ...(Object.fromEntries(PRICE_FIELDS.map((field) => [field, ""])) as Record<
    PriceField,
    string
  >),
  serviceTier: "standard",
};

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
