import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { db } from "@/db";
import { getSessionUser, type SessionUser } from "@/db/auth";
import { SESSION_COOKIE } from "./sessions";

/** The signed-in user for this request, or null. Cached per request. */
export const getCurrentUser = cache(async (): Promise<SessionUser | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return token ? getSessionUser(db, token) : null;
});

/**
 * Returns the signed-in user or redirects to the sign-in page. Call it in
 * every dashboard page and server action: actions are public endpoints and
 * can be invoked from any route, so a page-level check alone isn't enough.
 */
export async function requireUser(returnTo?: string): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) {
    redirect(
      returnTo ? `/login?next=${encodeURIComponent(returnTo)}` : "/login",
    );
  }
  return user;
}
