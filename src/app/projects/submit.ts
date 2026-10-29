import type { SaveProjectResult } from "@/db/projects";
import {
  parseProjectForm,
  type ProjectFormState,
  type ProjectFormValues,
} from "@/lib/projects";

export type SubmitProjectResult =
  { ok: true } | { ok: false; state: ProjectFormState };

/**
 * Validates a project form and saves it. Kept free of Next.js APIs so the
 * server actions stay thin and this logic can be unit-tested.
 */
export async function submitProjectForm(
  formData: FormData,
  save: (values: ProjectFormValues) => Promise<SaveProjectResult>,
): Promise<SubmitProjectResult> {
  const parsed = parseProjectForm(formData);
  if (!parsed.ok) return parsed;

  const result = await save(parsed.values);
  if (result.ok) return { ok: true };

  const values = {
    name: parsed.values.name,
    slug: parsed.values.slug,
    monthlyBudgetUsd: parsed.values.monthlyBudgetUsd ?? "",
  };
  if (result.error === "slug_taken") {
    return {
      ok: false,
      state: {
        values,
        fieldErrors: { slug: "Another project already uses this slug" },
      },
    };
  }
  return {
    ok: false,
    state: {
      values,
      fieldErrors: {},
      formError: "This project no longer exists",
    },
  };
}
