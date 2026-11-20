import type { CreateProjectApiKeyResult } from "@/db/api-keys";
import {
  EMPTY_API_KEY_FORM,
  parseApiKeyForm,
  type ApiKeyFormState,
  type ApiKeyFormValues,
} from "@/lib/api-key-form";

/**
 * Validates the new key form and creates the key. On success the form
 * empties and carries the key, its only copy, to show once.
 */
export async function submitApiKeyForm(
  formData: FormData,
  save: (values: ApiKeyFormValues) => Promise<CreateProjectApiKeyResult>,
): Promise<ApiKeyFormState> {
  const parsed = parseApiKeyForm(formData);
  if (!parsed.ok) return parsed.state;

  const result = await save(parsed.values);
  if (!result.ok) {
    return {
      values: { name: parsed.values.name, scope: parsed.values.scope },
      fieldErrors: {},
      formError: "This project no longer exists",
    };
  }
  return {
    ...EMPTY_API_KEY_FORM,
    created: {
      key: result.key,
      name: result.record.name,
      prefix: result.record.keyPrefix,
      scope: result.record.scope,
    },
  };
}
