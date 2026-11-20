import type { Metadata } from "next";
import { db } from "@/db";
import { listOrganizationAccounts } from "@/db/accounts";
import { USER_ROLES } from "@/db/schema";
import { requirePermission } from "@/lib/auth";
import {
  parseTeamStatus,
  ROLE_DESCRIPTIONS,
  TEAM_STATUS_MESSAGES,
} from "@/lib/team";
import { DashboardNav } from "../dashboard-nav";
import { changeRoleAction } from "./actions";

export const metadata: Metadata = { title: "Accounts · AI API Cost Tracker" };

// Reads the database on every request; never prerender at build time.
export const dynamic = "force-dynamic";

const utcDate = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  year: "numeric",
  month: "short",
  day: "numeric",
});

export default async function TeamPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requirePermission("team:manage", "/team");
  const status = parseTeamStatus((await searchParams).status);
  const message = status ? TEAM_STATUS_MESSAGES[status] : null;
  const accounts = await listOrganizationAccounts(db, user.organizationId);

  return (
    <main className="mx-auto flex min-h-screen max-w-4xl flex-col gap-8 px-4 py-12 sm:px-8">
      <DashboardNav user={user} current="/team" />
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">Accounts</h1>
        <p className="max-w-2xl text-sm text-foreground/70">
          Everyone who can sign in to your organization. A new role applies from
          their next page, without signing them out. Each organization keeps at
          least one admin. To add someone, run{" "}
          <code className="font-mono">
            npm run user -- create --email &lt;email&gt;
          </code>{" "}
          for now.
        </p>
        <dl className="grid max-w-2xl gap-1 text-sm sm:grid-cols-[auto_1fr] sm:gap-x-4">
          {USER_ROLES.map((role) => (
            <div key={role} className="contents">
              <dt className="font-medium capitalize">{role}</dt>
              <dd className="text-foreground/70">{ROLE_DESCRIPTIONS[role]}</dd>
            </div>
          ))}
        </dl>
      </div>

      {message && (
        <p
          role={message.tone === "error" ? "alert" : "status"}
          data-status={status}
          className={
            message.tone === "error"
              ? "rounded-md border border-red-600/40 px-3 py-2 text-sm text-red-700 dark:text-red-400"
              : "rounded-md border border-green-700/40 px-3 py-2 text-sm"
          }
        >
          {message.text}
        </p>
      )}

      <div className="overflow-x-auto rounded-lg border border-foreground/10">
        <table className="w-full min-w-[40rem] text-left text-sm">
          <thead className="border-b border-foreground/10 text-foreground/60">
            <tr>
              <th scope="col" className="px-4 py-3 font-medium">
                Email
              </th>
              <th scope="col" className="px-4 py-3 font-medium">
                Added
              </th>
              <th scope="col" className="px-4 py-3 text-right font-medium">
                Active sessions
              </th>
              <th scope="col" className="px-4 py-3 font-medium">
                Role
              </th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((account) => (
              <tr
                key={account.id}
                className="border-b border-foreground/10 last:border-0"
              >
                <td className="px-4 py-3 font-medium">
                  {account.email}
                  {account.id === user.id && (
                    <span className="ml-2 text-xs text-foreground/60">
                      (you)
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 tabular-nums">
                  {utcDate.format(account.createdAt)}
                </td>
                <td className="px-4 py-3 text-right tabular-nums">
                  {account.activeSessions}
                </td>
                <td className="px-4 py-3">
                  <form
                    action={changeRoleAction.bind(null, account.id)}
                    className="flex items-center gap-2"
                  >
                    <label htmlFor={`role-${account.id}`} className="sr-only">
                      Role for {account.email}
                    </label>
                    <select
                      id={`role-${account.id}`}
                      name="role"
                      defaultValue={account.role}
                      className="rounded-md border border-foreground/20 bg-background px-2 py-1"
                    >
                      {USER_ROLES.map((role) => (
                        <option key={role} value={role}>
                          {role}
                        </option>
                      ))}
                    </select>
                    <button
                      type="submit"
                      aria-label={`Change role for ${account.email}`}
                      className="rounded-md border border-foreground/20 px-3 py-1"
                    >
                      Change
                    </button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
