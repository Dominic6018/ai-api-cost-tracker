import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { db } from "@/db";
import { getProject } from "@/db/projects";
import { isDashboardEnabled } from "@/lib/dashboard";
import { updateProjectAction } from "../../actions";
import { ProjectForm } from "../../project-form";

export const metadata: Metadata = {
  title: "Edit project · AI API Cost Tracker",
};

export const dynamic = "force-dynamic";

export default async function EditProjectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  if (!isDashboardEnabled()) notFound();
  const { id } = await params;
  const project = await getProject(db, id);
  if (!project) notFound();

  return (
    <main className="mx-auto flex min-h-screen max-w-4xl flex-col gap-8 px-4 py-12 sm:px-8">
      <h1 className="text-3xl font-semibold tracking-tight">
        Edit {project.name}
      </h1>
      <ProjectForm
        action={updateProjectAction.bind(null, project.id)}
        initialValues={{
          name: project.name,
          slug: project.slug,
          monthlyBudgetUsd: project.monthlyBudgetUsd ?? "",
        }}
        submitLabel="Save changes"
      />
    </main>
  );
}
