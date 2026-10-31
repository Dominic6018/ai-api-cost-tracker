"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { createSession, deleteSession } from "@/db/auth";
import { signIn } from "@/db/sign-in";
import { parseLoginForm, type LoginFormState } from "@/lib/login";
import { clientIp } from "@/lib/rate-limit";
import { safeRedirectPath, SESSION_COOKIE } from "@/lib/sessions";

export async function loginAction(
  _previous: LoginFormState | undefined,
  formData: FormData,
): Promise<LoginFormState> {
  const parsed = parseLoginForm(formData);
  if (!parsed.ok) return parsed.state;

  const result = await signIn(db, {
    ...parsed,
    clientIp: clientIp(await headers()),
  });
  if (!result.ok) {
    return {
      email: parsed.email,
      // One message for unknown emails and wrong passwords alike, and one
      // for every rate limit, so neither reveals which accounts exist.
      error:
        result.error === "rate_limited"
          ? "Too many sign-in attempts. Try again later."
          : "Invalid email or password",
    };
  }

  const { token, expiresAt } = await createSession(db, result.user.id);
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
  redirect(safeRedirectPath(formData.get("next")));
}

export async function logoutAction(): Promise<void> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) await deleteSession(db, token);
  store.delete(SESSION_COOKIE);
  redirect("/login");
}
