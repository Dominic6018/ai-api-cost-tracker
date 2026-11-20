"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { createProjectApiKey, revokeProjectApiKey } from "@/db/api-keys";
import { audited, userActor } from "@/db/audit";
import { getProject } from "@/db/projects";
import { organizationScope } from "@/db/scope";
import type { ApiKeyFormState } from "@/lib/api-key-form";
import { apiKeyCreatedEntry, apiKeyRevokedEntry } from "@/lib/audit";
import { requirePermission } from "@/lib/auth";
import { submitApiKeyForm } from "./submit";

// Server actions can be called from any route, so each one checks the
// session and role itself, and finds the project in the account's own
// organization, never one the form names.

export async function createApiKeyAction(
  projectId: string,
  _previous: ApiKeyFormState | undefined,
  formData: FormData,
): Promise<ApiKeyFormState> {
  const user = await requirePermission("api_keys:manage");
  const scope = organizationScope(user);
  const state = await submitApiKeyForm(formData, (values) =>
    audited(db, userActor(user), async (tx) => {
      const project = await getProject(tx, scope, projectId);
      if (!project) {
        return {
          result: { ok: false, error: "not_found" } as const,
          entry: null,
        };
      }
      const created = await createProjectApiKey(tx, scope, {
        projectId: project.id,
        name: values.name,
        keyScope: values.scope,
      });
      return {
        result: created,
        entry: created.ok ? apiKeyCreatedEntry(project, created.record) : null,
      };
    }),
  );
  revalidatePath(`/projects/${projectId}/keys`);
  return state;
}

export async function revokeApiKeyAction(
  projectId: string,
  keyId: string,
): Promise<void> {
  const user = await requirePermission("api_keys:manage");
  const scope = organizationScope(user);
  await audited(db, userActor(user), async (tx) => {
    const project = await getProject(tx, scope, projectId);
    const revoked = project
      ? await revokeProjectApiKey(tx, scope, { projectId, keyId })
      : null;
    return {
      result: revoked,
      // Revoking a key that's already revoked changes nothing.
      entry: project && revoked ? apiKeyRevokedEntry(project, revoked) : null,
    };
  });
  revalidatePath(`/projects/${projectId}/keys`);
  redirect(`/projects/${projectId}/keys`);
}
