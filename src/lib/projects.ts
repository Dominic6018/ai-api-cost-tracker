import { z } from "zod";

/** Largest value `monthly_budget_usd numeric(12, 2)` can hold. */
export const MAX_BUDGET_USD = 9_999_999_999.99;

export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Fields submitted by the create and edit project forms. */
export const projectFormSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Name is required")
    .max(100, "Name must be at most 100 characters"),
  slug: z
    .string()
    .trim()
    .min(1, "Slug is required")
    .max(64, "Slug must be at most 64 characters")
    .regex(
      SLUG_PATTERN,
      "Use lowercase letters, numbers and single hyphens, e.g. my-app",
    ),
  // An empty field means "no budget".
  monthlyBudgetUsd: z
    .string()
    .trim()
    .transform((value) => (value === "" ? null : value))
    .refine(
      (value) => value === null || /^\d+(\.\d{1,2})?$/.test(value),
      "Enter an amount like 100 or 99.50, or leave it empty for no budget",
    )
    .refine(
      (value) => value === null || Number(value) <= MAX_BUDGET_USD,
      "Budget is too large",
    ),
});

export type ProjectFormValues = z.infer<typeof projectFormSchema>;

/** What the form shows after a submission: field errors and the values to refill. */
export interface ProjectFormState {
  fieldErrors: Partial<Record<keyof ProjectFormValues, string>>;
  formError?: string;
  values: Record<keyof ProjectFormValues, string>;
}

export type ParseProjectFormResult =
  | { ok: true; values: ProjectFormValues }
  | { ok: false; state: ProjectFormState };

function field(formData: FormData, name: keyof ProjectFormValues): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

export function parseProjectForm(formData: FormData): ParseProjectFormResult {
  const raw = {
    name: field(formData, "name"),
    slug: field(formData, "slug"),
    monthlyBudgetUsd: field(formData, "monthlyBudgetUsd"),
  };
  const result = projectFormSchema.safeParse(raw);
  if (result.success) return { ok: true, values: result.data };

  const { fieldErrors } = z.flattenError(result.error);
  return {
    ok: false,
    state: {
      values: raw,
      fieldErrors: {
        name: fieldErrors.name?.[0],
        slug: fieldErrors.slug?.[0],
        monthlyBudgetUsd: fieldErrors.monthlyBudgetUsd?.[0],
      },
    },
  };
}
