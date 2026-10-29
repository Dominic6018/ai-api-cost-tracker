"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { createSession, deleteSession, verifyCredentials } from "@/db/auth";
import { parseLoginForm, type LoginFormState } from "@/lib/login";
import { safeRedirectPath, SESSION_COOKIE } from "@/lib/sessions";

export async function loginAction(
  _previous: LoginFormState | undefined,
  formData: FormData,
): Promise<LoginFormState> {
  const parsed = parseLoginForm(formData);
  if (!parsed.ok) return parsed.state;

  const user = await verifyCredentials(db, parsed);
  // One message for unknown emails and wrong passwords alike.
  if (!user) return { email: parsed.email, error: "Invalid email or password" };

  const { token, expiresAt } = await createSession(db, user.id);
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
