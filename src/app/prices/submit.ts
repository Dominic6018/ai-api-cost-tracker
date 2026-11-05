import type { AddPriceResult } from "@/db/pricing";
import {
  parsePriceForm,
  readPriceForm,
  type PriceFormState,
  type PriceInput,
} from "@/lib/price-form";

export type SubmitPriceResult =
  { ok: true } | { ok: false; state: PriceFormState };

/**
 * Validates the add-price form and saves it. Kept free of Next.js APIs so
 * the server action stays thin and this logic can be unit-tested.
 */
export async function submitPriceForm(
  formData: FormData,
  save: (input: PriceInput) => Promise<AddPriceResult>,
  now: Date = new Date(),
): Promise<SubmitPriceResult> {
  const parsed = parsePriceForm(formData, now);
  if (!parsed.ok) return parsed;

  const result = await save(parsed.input);
  if (result.ok) return { ok: true };

  return {
    ok: false,
    state: {
      values: readPriceForm(formData),
      fieldErrors: {
        effectiveFrom:
          "This model already has a price starting at this time; choose another",
      },
    },
  };
}
