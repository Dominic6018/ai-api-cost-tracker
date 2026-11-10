import { NextResponse } from "next/server";
import { startSso } from "@/lib/oidc-client";
import { SSO_COOKIE, ssoCookieOptions } from "@/lib/oidc-cookie";
import { parseOidcConfig } from "@/lib/oidc";
import { safeRedirectPath } from "@/lib/sessions";

export const dynamic = "force-dynamic";

/** Starts single sign-on: sends the browser to the provider. */
export async function GET(request: Request) {
  const oidc = parseOidcConfig(process.env);
  if (!oidc) return new NextResponse("Not found", { status: 404 });
  const next = safeRedirectPath(new URL(request.url).searchParams.get("next"));
  const { url, checks } = await startSso(oidc, next);
  const response = NextResponse.redirect(url);
  response.cookies.set(
    SSO_COOKIE,
    JSON.stringify(checks),
    ssoCookieOptions(oidc),
  );
  return response;
}
