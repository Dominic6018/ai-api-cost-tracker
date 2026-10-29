import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isDashboardEnabled } from "@/lib/dashboard";
import { createProjectAction } from "../actions";
import { ProjectForm } from "../project-form";

export const metadata: Metadata = {
  title: "New project · AI API Cost Tracker",
};

export const dynamic = "force-dynamic";

export default function NewProjectPage() {
  if (!isDashboardEnabled()) notFound();

  return (
    <main className="mx-auto flex min-h-screen max-w-4xl flex-col gap-8 px-4 py-12 sm:px-8">
      <h1 className="text-3xl font-semibold tracking-tight">New project</h1>
      <ProjectForm action={createProjectAction} submitLabel="Create project" />
    </main>
  );
}
