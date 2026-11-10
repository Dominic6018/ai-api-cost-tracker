import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { parseOidcConfig, SSO_ERRORS } from "@/lib/oidc";
import { safeRedirectPath } from "@/lib/sessions";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in · AI API Cost Tracker" };

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{
    next?: string | string[];
    error?: string | string[];
  }>;
}) {
  const params = await searchParams;
  const next = safeRedirectPath(params.next);
  if (await getCurrentUser()) redirect(next);
  const oidc = parseOidcConfig(process.env);
  const error =
    typeof params.error === "string" && params.error in SSO_ERRORS
      ? SSO_ERRORS[params.error as keyof typeof SSO_ERRORS]
      : null;

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-8 px-4 py-12">
      <div className="flex flex-col gap-1">
        <p className="text-sm text-foreground/60">AI API Cost Tracker</p>
        <h1 className="text-3xl font-semibold tracking-tight">Sign in</h1>
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
      {oidc && (
        <a
          href={`/login/oidc?next=${encodeURIComponent(next)}`}
          className="rounded-md border border-foreground/20 px-4 py-2 text-center font-medium"
        >
          Sign in with {oidc.name}
        </a>
      )}
      <LoginForm next={next} />
      <p className="text-xs text-foreground/60">
        Accounts are created with <code>npm run user -- create</code>.
      </p>
    </main>
  );
}
