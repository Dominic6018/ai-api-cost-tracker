import { API_KEY_SCOPES, type ApiKeyScope } from "@/db/schema";

export const MAX_API_KEY_NAME_LENGTH = 100;

export interface ApiKeyFormValues {
  name: string;
  scope: ApiKeyScope;
}

/** A key just created: shown once, in the response to the form. */
export interface CreatedApiKey {
  key: string;
  name: string;
  prefix: string;
  scope: ApiKeyScope;
}

/** What the create form shows after a submission. */
export interface ApiKeyFormState {
  values: { name: string; scope: string };
  fieldErrors: Partial<Record<keyof ApiKeyFormValues, string>>;
  formError?: string;
  created?: CreatedApiKey;
}

export const EMPTY_API_KEY_FORM: ApiKeyFormState = {
  values: { name: "", scope: "ingest" },
  fieldErrors: {},
};

export type ParseApiKeyFormResult =
  | { ok: true; values: ApiKeyFormValues }
  | { ok: false; state: ApiKeyFormState };

const text = (formData: FormData, name: string) => {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
};

export function parseApiKeyForm(formData: FormData): ParseApiKeyFormResult {
  const raw = { name: text(formData, "name"), scope: text(formData, "scope") };
  const name = raw.name.trim();
  const fieldErrors: ApiKeyFormState["fieldErrors"] = {};
  if (name === "") {
    fieldErrors.name = "Name is required, e.g. production or ci";
  } else if (name.length > MAX_API_KEY_NAME_LENGTH) {
    fieldErrors.name = `Name must be at most ${MAX_API_KEY_NAME_LENGTH} characters`;
  }
  if (!(API_KEY_SCOPES as readonly string[]).includes(raw.scope)) {
    fieldErrors.scope = "Choose what the key may do";
  }
  if (fieldErrors.name || fieldErrors.scope) {
    return { ok: false, state: { values: raw, fieldErrors } };
  }
  return { ok: true, values: { name, scope: raw.scope as ApiKeyScope } };
}

export const API_KEY_SCOPE_LABELS: Record<ApiKeyScope, string> = {
  ingest: "Send usage",
  read: "Read reports",
};
