"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { createProject, updateProject } from "@/db/projects";
import { requirePermission } from "@/lib/auth";
import type { ProjectFormState } from "@/lib/projects";
import { submitProjectForm } from "./submit";

// Server actions can be called from any route, so each one checks the
// session and role itself rather than relying on the page with the form.

export async function createProjectAction(
  _previous: ProjectFormState | undefined,
  formData: FormData,
): Promise<ProjectFormState> {
  await requirePermission("projects:manage");
  const result = await submitProjectForm(formData, (values) =>
    createProject(db, values),
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
  await requirePermission("projects:manage");
  const result = await submitProjectForm(formData, (values) =>
    updateProject(db, id, values),
  );
  if (!result.ok) return result.state;

  revalidatePath("/projects");
  redirect("/projects");
}
