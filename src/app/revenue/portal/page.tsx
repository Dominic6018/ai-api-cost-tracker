import type { Metadata } from "next";
import { db } from "@/db";
import { listBillingCustomers } from "@/db/billing";
import { listPortalLinks } from "@/db/billing-portal";
import { organizationScope } from "@/db/scope";
import { requirePermission } from "@/lib/auth";
import { DashboardNav } from "../../dashboard-nav";
import { createPortalLinkAction, revokePortalLinkAction } from "./actions";
import { PortalLinkForm } from "./portal-link-form";

export const metadata: Metadata = {
  title: "Portal links · AI API Cost Tracker",
};

// Reads the database on every request; never prerender at build time.
export const dynamic = "force-dynamic";

const utcDate = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  year: "numeric",
  month: "short",
  day: "numeric",
});

const STATUS = {
  revoked: { tone: "ok", text: "Link revoked. It no longer opens anything." },
  not_found: { tone: "error", text: "That link is no longer working." },
} as const;

export default async function PortalLinksPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requirePermission("portal:manage", "/revenue/portal");
  const statusParam = (await searchParams).status;
  const status =
    typeof statusParam === "string" && Object.hasOwn(STATUS, statusParam)
      ? STATUS[statusParam as keyof typeof STATUS]
      : null;
  const [customers, links] = await Promise.all([
    listBillingCustomers(db, organizationScope(user)),
    listPortalLinks(db, user.organizationId),
  ]);

  return (
    <main className="mx-auto flex min-h-screen max-w-4xl flex-col gap-8 px-4 py-12 sm:px-8">
      <DashboardNav user={user} current="/revenue/portal" />
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">Portal links</h1>
        <p className="max-w-2xl text-sm text-foreground/70">
          A portal link lets one billing customer read their own statement
          without an account: what they owe, their plan and fee, credit left,
          and each entry with its description. It never shows your AI API cost,
          usage multipliers or who entered anything. A link works for 90 days,
          or until you revoke it.
        </p>
      </div>

      {status && (
        <p
          role={status.tone === "error" ? "alert" : "status"}
          className={
            status.tone === "error"
              ? "rounded-md border border-red-600/40 px-3 py-2 text-sm text-red-700 dark:text-red-400"
              : "rounded-md border border-green-700/40 px-3 py-2 text-sm"
          }
        >
          {status.text}
        </p>
      )}

      {customers.length === 0 ? (
        <p className="rounded-lg border border-dashed border-foreground/20 p-8 text-center text-foreground/70">
          No billing customers yet. Add one with{" "}
          <code className="font-mono">npm run billing -- customer-add</code>.
        </p>
      ) : (
        <PortalLinkForm
          action={createPortalLinkAction}
          customers={customers.map(({ customer }) => ({
            id: customer.id,
            label: `${customer.name} (${customer.externalId})`,
          }))}
        />
      )}

      <section className="flex flex-col gap-3" aria-labelledby="links-heading">
        <h2 id="links-heading" className="text-lg font-semibold">
          Working links
        </h2>
        {links.length === 0 ? (
          <p className="text-sm text-foreground/70">None.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-foreground/10">
            <table className="w-full min-w-[40rem] text-left text-sm">
              <thead className="border-b border-foreground/10 text-foreground/60">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Customer
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Made by
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Works until
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Last opened
                  </th>
                  <th scope="col" className="px-4 py-3">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {links.map((link) => (
                  <tr
                    key={link.id}
                    className="border-b border-foreground/10 last:border-0"
                  >
                    <td className="px-4 py-3 font-medium">
                      {link.customer.name}{" "}
                      <span className="font-mono text-xs text-foreground/60">
                        {link.customer.externalId}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-foreground/70">
                      {link.createdBy}
                    </td>
                    <td className="px-4 py-3 tabular-nums">
                      {utcDate.format(link.expiresAt)}
                    </td>
                    <td className="px-4 py-3 tabular-nums">
                      {link.lastViewedAt
                        ? utcDate.format(link.lastViewedAt)
                        : "Never"}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <form action={revokePortalLinkAction.bind(null, link.id)}>
                        <button
                          type="submit"
                          aria-label={`Revoke the portal link for ${link.customer.externalId} made ${utcDate.format(link.createdAt)}`}
                          data-link-id={link.id}
                          className="text-red-700 underline dark:text-red-400"
                        >
                          Revoke
                        </button>
                      </form>
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
