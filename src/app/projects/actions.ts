"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { audited, userActor } from "@/db/audit";
import { createProject, getProject, updateProject } from "@/db/projects";
import { organizationScope } from "@/db/scope";
import { projectCreatedEntry, projectUpdatedEntry } from "@/lib/audit";
import { requirePermission } from "@/lib/auth";
import type { ProjectFormState } from "@/lib/projects";
import { submitProjectForm } from "./submit";

// Server actions can be called from any route, so each one checks the
// session and role itself rather than relying on the page with the form.

export async function createProjectAction(
  _previous: ProjectFormState | undefined,
  formData: FormData,
): Promise<ProjectFormState> {
  const user = await requirePermission("projects:manage");
  const result = await submitProjectForm(formData, (values) =>
    audited(db, userActor(user), async (tx) => {
      // The account's organization, never one sent by the form.
      const saved = await createProject(tx, {
        ...values,
        organizationId: user.organizationId,
      });
      return {
        result: saved,
        entry: saved.ok ? projectCreatedEntry(saved.project) : null,
      };
    }),
  );
  if (!result.ok) return result.state;

  revalidatePath("/projects");
  redirect("/projects");
}

export async function updateProjectAction(
  id: string,
  _previous: ProjectFormState | undefined,
  formData: FormData,
): Promise<ProjectFormState> {
  const user = await requirePermission("projects:manage");
  const result = await submitProjectForm(formData, (values) =>
    audited(db, userActor(user), async (tx) => {
      const scope = organizationScope(user);
      const before = await getProject(tx, scope, id);
      if (!before) {
        return {
          result: { ok: false, error: "not_found" } as const,
          entry: null,
        };
      }
      const saved = await updateProject(tx, scope, id, values);
      return {
        result: saved,
        entry: saved.ok ? projectUpdatedEntry(before, saved.project) : null,
      };
    }),
  );
  if (!result.ok) return result.state;

  revalidatePath("/projects");
  redirect("/projects");
}
