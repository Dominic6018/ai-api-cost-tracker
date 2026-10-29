import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { safeRedirectPath } from "@/lib/sessions";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in · AI API Cost Tracker" };

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const next = safeRedirectPath((await searchParams).next);
  if (await getCurrentUser()) redirect(next);

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-8 px-4 py-12">
      <div className="flex flex-col gap-1">
        <p className="text-sm text-foreground/60">AI API Cost Tracker</p>
        <h1 className="text-3xl font-semibold tracking-tight">Sign in</h1>
      </div>
      <LoginForm next={next} />
      <p className="text-xs text-foreground/60">
        Accounts are created with <code>npm run user -- create</code>.
      </p>
    </main>
  );
}
