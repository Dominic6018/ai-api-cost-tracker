import type { Metadata } from "next";
import Link from "next/link";
import { requireUser } from "@/lib/auth";

export const metadata: Metadata = {
  title: "No access · AI API Cost Tracker",
};

export const dynamic = "force-dynamic";

export default async function NoAccessPage() {
  const user = await requireUser("/no-access");

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-4 px-4 py-12 sm:px-8">
      <h1 className="text-3xl font-semibold tracking-tight">
        You can&apos;t do that
      </h1>
      <p className="text-foreground/70">
        Your account&apos;s role is <strong>{user.role}</strong>, which
        doesn&apos;t allow this change. Ask an admin if you need it.
      </p>
      <Link href="/overview" className="text-sm underline">
        Back to the overview
      </Link>
    </main>
  );
}
