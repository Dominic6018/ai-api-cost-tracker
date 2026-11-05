import { z } from "zod";
import { checkedOnField, sourceUrlField, utcDateTimeField } from "./price-form";

/** Every field of the end-price form, as submitted. */
export const END_PRICE_FIELDS = ["endsAt", "sourceUrl", "checkedOn"] as const;

export type EndPriceField = (typeof END_PRICE_FIELDS)[number];

export interface EndPriceInput {
  endsAt: Date;
  sourceUrl: string;
  checkedOn: string;
}

/** What the form shows after a submission: field errors and the values to refill. */
export interface EndPriceFormState {
  fieldErrors: Partial<Record<EndPriceField, string>>;
  formError?: string;
  values: Record<EndPriceField, string>;
}

export const EMPTY_END_PRICE_FORM: Record<EndPriceField, string> = {
  endsAt: "",
  sourceUrl: "",
  checkedOn: "",
};

export type ParseEndPriceFormResult =
  { ok: true; input: EndPriceInput } | { ok: false; state: EndPriceFormState };

/** The form's fields as submitted; missing fields are empty. */
export function readEndPriceForm(
  formData: FormData,
): Record<EndPriceField, string> {
  return Object.fromEntries(
    END_PRICE_FIELDS.map((field) => {
      const value = formData.get(field);
      return [field, typeof value === "string" ? value : ""];
    }),
  ) as Record<EndPriceField, string>;
}

/**
 * Validates the end-price form. When the price ends is checked against
 * the price itself when saving, since that needs the stored row.
 */
export function parseEndPriceForm(
  formData: FormData,
  now: Date,
): ParseEndPriceFormResult {
  const values = readEndPriceForm(formData);
  const result = z
    .object({
      endsAt: utcDateTimeField,
      sourceUrl: sourceUrlField(
        "Where was the end announced? Enter the page's URL, e.g. the deprecation notice",
      ),
      checkedOn: checkedOnField(now),
    })
    .safeParse(values);
  if (result.success) return { ok: true, input: result.data };

  const fieldErrors: EndPriceFormState["fieldErrors"] = {};
  for (const issue of result.error.issues) {
    const field = issue.path[0] as EndPriceField | undefined;
    if (field && !fieldErrors[field]) fieldErrors[field] = issue.message;
  }
  return { ok: false, state: { values, fieldErrors } };
}
