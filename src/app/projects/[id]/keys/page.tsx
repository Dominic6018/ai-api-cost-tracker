import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/db";
import { listProjectApiKeys } from "@/db/api-keys";
import { getProject } from "@/db/projects";
import { organizationScope } from "@/db/scope";
import { API_KEY_SCOPE_LABELS } from "@/lib/api-key-form";
import { requirePermission } from "@/lib/auth";
import { DashboardNav } from "../../../dashboard-nav";
import { createApiKeyAction, revokeApiKeyAction } from "./actions";
import { ApiKeyForm } from "./api-key-form";

export const metadata: Metadata = {
  title: "API keys · AI API Cost Tracker",
};

// Reads the database on every request; never prerender at build time.
export const dynamic = "force-dynamic";

const utcDateTime = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const when = (date: Date | null) =>
  date ? `${utcDateTime.format(date)} UTC` : "Never";

export default async function ApiKeysPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await requirePermission(
    "api_keys:manage",
    `/projects/${id}/keys`,
  );
  const scope = organizationScope(user);
  const project = await getProject(db, scope, id);
  if (!project) notFound();
  const keys = await listProjectApiKeys(db, scope, project.id);

  return (
    <main className="mx-auto flex min-h-screen max-w-4xl flex-col gap-8 px-4 py-12 sm:px-8">
      <DashboardNav user={user} current="/projects" />
      <div className="flex flex-col gap-1">
        <Link href="/projects" className="text-sm text-foreground/60 underline">
          Projects
        </Link>
        <h1 className="text-3xl font-semibold tracking-tight">
          API keys for {project.name}
        </h1>
        <p className="max-w-2xl text-sm text-foreground/70">
          Your code sends usage for{" "}
          <span className="font-mono">{project.slug}</span> with one of these
          keys. Only a key&apos;s prefix and a hash of it are kept, so a key is
          shown once, when it&apos;s created. A revoked key is refused from then
          on; usage it already sent stays. The command line still works:{" "}
          <code className="font-mono">npm run api-key</code>.
        </p>
      </div>

      <ApiKeyForm action={createApiKeyAction.bind(null, project.id)} />

      <section className="flex flex-col gap-3" aria-labelledby="keys-heading">
        <h2 id="keys-heading" className="text-lg font-semibold">
          Keys
        </h2>
        {keys.length === 0 ? (
          <p className="rounded-lg border border-dashed border-foreground/20 p-8 text-center text-foreground/70">
            No keys yet. Create one above to start sending usage.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-foreground/10">
            <table className="w-full min-w-[44rem] text-left text-sm">
              <thead className="border-b border-foreground/10 text-foreground/60">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Name
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Prefix
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    May
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Created
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Last used
                  </th>
                  <th scope="col" className="px-4 py-3">
                    <span className="sr-only">Status</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {keys.map((key) => (
                  <tr
                    key={key.id}
                    className="border-b border-foreground/10 last:border-0"
                  >
                    <td className="px-4 py-3 font-medium">{key.name}</td>
                    <td className="px-4 py-3 font-mono text-foreground/80">
                      {key.keyPrefix}
                    </td>
                    <td className="px-4 py-3">
                      {API_KEY_SCOPE_LABELS[key.scope]}
                    </td>
                    <td className="px-4 py-3 tabular-nums">
                      {when(key.createdAt)}
                    </td>
                    <td className="px-4 py-3 tabular-nums">
                      {when(key.lastUsedAt)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {key.revokedAt ? (
                        <span className="text-foreground/60">
                          Revoked {when(key.revokedAt)}
                        </span>
                      ) : (
                        <form
                          action={revokeApiKeyAction.bind(
                            null,
                            project.id,
                            key.id,
                          )}
                        >
                          <button
                            type="submit"
                            aria-label={`Revoke ${key.name} (${key.keyPrefix})`}
                            className="text-red-700 underline dark:text-red-400"
                          >
                            Revoke
                          </button>
                        </form>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
