import { NextResponse } from "next/server";
import { db } from "@/db";
import { createSession } from "@/db/auth";
import { accountForSso } from "@/db/oidc";
import { finishSso } from "@/lib/oidc-client";
import { readSsoChecks, SSO_COOKIE, ssoCookieOptions } from "@/lib/oidc-cookie";
import { parseOidcConfig, ssoIdentity, type SsoError } from "@/lib/oidc";
import { safeRedirectPath, SESSION_COOKIE } from "@/lib/sessions";

export const dynamic = "force-dynamic";

/** The provider sends the browser back here with a code. */
export async function GET(request: Request) {
  const oidc = parseOidcConfig(process.env);
  if (!oidc) return new NextResponse("Not found", { status: 404 });
  // Redirects use the registered URI's origin, not the request's host.
  const origin = new URL(oidc.redirectUri).origin;
  const cookieHeader = request.headers.get("cookie") ?? "";
  const raw = cookieHeader
    .split(/;\s*/)
    .find((c) => c.startsWith(`${SSO_COOKIE}=`))
    ?.slice(SSO_COOKIE.length + 1);
  const checks = readSsoChecks(raw ? decodeURIComponent(raw) : undefined);

  const fail = (error: SsoError) => {
    const response = NextResponse.redirect(
      new URL(`/login?error=${error}`, origin),
    );
    // One attempt per cookie.
    response.cookies.set(SSO_COOKIE, "", {
      ...ssoCookieOptions(oidc),
      maxAge: 0,
    });
    return response;
  };
  if (!checks) return fail("sso_failed");

  let claims: Record<string, unknown>;
  try {
    claims = await finishSso(oidc, new URL(request.url).searchParams, checks);
  } catch {
    // A wrong state, a replayed code, a bad signature or nonce, or the
    // provider reporting an error: the details stay out of the URL.
    return fail("sso_failed");
  }
  const identity = ssoIdentity(claims);
  if (!identity.ok) return fail("sso_denied");
  const user = await accountForSso(db, identity);
  if (!user) return fail("sso_denied");

  const { token, expiresAt } = await createSession(db, user.id);
  const response = NextResponse.redirect(
    new URL(safeRedirectPath(checks.next), origin),
    303,
  );
  response.cookies.set(SSO_COOKIE, "", {
    ...ssoCookieOptions(oidc),
    maxAge: 0,
  });
  response.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
  return response;
}
