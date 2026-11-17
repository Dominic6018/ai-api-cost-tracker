import Link from "next/link";
import type { SessionUser } from "@/db/auth";
import { navigationFor } from "@/lib/navigation";
import { logoutAction } from "./login/actions";

/**
 * The navigation bar on every dashboard page: the sections, the current
 * section's pages, and the account with a way to sign out.
 */
export function DashboardNav({
  user,
  current,
}: {
  user: SessionUser;
  /** The page's path, e.g. "/spend", to mark where the account is. */
  current: string;
}) {
  const sections = navigationFor(user, current);
  const active = sections.find((s) => s.active);
  return (
    <div
      className="flex flex-col gap-3 border-b border-foreground/10 pb-4"
      data-testid="dashboard-nav"
    >
      <div className="flex flex-wrap items-center justify-between gap-4">
        <nav
          aria-label="Sections"
          className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm"
        >
          <Link href="/" className="font-semibold">
            AI API Cost Tracker
          </Link>
          {sections.map((section) => (
            <Link
              key={section.label}
              href={section.links[0].href}
              aria-current={section.active ? "page" : undefined}
              className={
                section.active
                  ? "font-medium underline underline-offset-4"
                  : "text-foreground/70 hover:underline"
              }
            >
              {section.label}
            </Link>
          ))}
        </nav>
        <form action={logoutAction} className="flex items-center gap-3 text-sm">
          <span className="text-foreground/60">{user.email}</span>
          <button type="submit" className="underline">
            Sign out
          </button>
        </form>
      </div>
      {active && active.links.length > 1 && (
        <nav
          aria-label={active.label}
          className="flex flex-wrap gap-x-4 gap-y-1 text-sm"
        >
          {active.links.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              aria-current={link.href === current ? "page" : undefined}
              className={
                link.href === current
                  ? "font-medium"
                  : "text-foreground/60 hover:underline"
              }
            >
              {link.label}
            </Link>
          ))}
        </nav>
      )}
    </div>
  );
}
