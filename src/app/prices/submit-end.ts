import type { EndPriceResult } from "@/db/pricing";
import {
  parseEndPriceForm,
  readEndPriceForm,
  type EndPriceFormState,
  type EndPriceInput,
} from "@/lib/price-end-form";

export type SubmitEndPriceResult =
  { ok: true } | { ok: false; state: EndPriceFormState };

/**
 * Validates the end-price form and saves it. Kept free of Next.js APIs so
 * the server action stays thin and this logic can be unit-tested.
 */
export async function submitEndPriceForm(
  formData: FormData,
  save: (input: EndPriceInput) => Promise<EndPriceResult>,
  now: Date = new Date(),
): Promise<SubmitEndPriceResult> {
  const parsed = parseEndPriceForm(formData, now);
  if (!parsed.ok) return parsed;

  const result = await save(parsed.input);
  if (result.ok) return { ok: true };

  const values = readEndPriceForm(formData);
  return {
    ok: false,
    state:
      result.error === "invalid_end"
        ? {
            values,
            fieldErrors: {
              endsAt:
                "Choose a time after this price starts and before any end it already has",
            },
          }
        : { values, fieldErrors: {}, formError: "This price no longer exists" },
  };
}
