import { describe, expect, it } from "vitest";
import { parseOidcConfig, ssoIdentity } from "./oidc";

const env = {
  OIDC_ISSUER: "https://example.okta.com",
  OIDC_CLIENT_ID: "client-1",
  OIDC_CLIENT_SECRET: "s3cr3t-value",
  OIDC_REDIRECT_URI: "https://costs.example.com/login/oidc/callback",
};

describe("parseOidcConfig", () => {
  it("is null when single sign-on isn't set up", () => {
    expect(parseOidcConfig({})).toBeNull();
    expect(
      parseOidcConfig({ OIDC_ISSUER: " ", OIDC_CLIENT_ID: "" }),
    ).toBeNull();
  });

  it("reads a confidential client", () => {
    expect(parseOidcConfig({ ...env, OIDC_NAME: "Okta" })).toEqual({
      issuer: "https://example.okta.com",
      clientId: "client-1",
      clientSecret: "s3cr3t-value",
      redirectUri: "https://costs.example.com/login/oidc/callback",
      name: "Okta",
      allowHttp: false,
    });
  });

  it("reads a public client and names the button by default", () => {
    const config = parseOidcConfig({ ...env, OIDC_CLIENT_SECRET: "" });
    expect(config).not.toHaveProperty("clientSecret");
    expect(config?.name).toBe("single sign-on");
  });

  it("refuses plain http unless allowed for a test provider", () => {
    const http = {
      ...env,
      OIDC_ISSUER: "http://localhost:8080/default",
      OIDC_REDIRECT_URI: "http://localhost:3000/login/oidc/callback",
    };
    expect(() => parseOidcConfig(http)).toThrow(/https/);
    expect(
      parseOidcConfig({ ...http, OIDC_ALLOW_HTTP: "true" })?.allowHttp,
    ).toBe(true);
  });

  it.each([
    [{ OIDC_ISSUER: env.OIDC_ISSUER }, /OIDC_CLIENT_ID/],
    [{ ...env, OIDC_REDIRECT_URI: undefined }, /OIDC_REDIRECT_URI/],
    [{ ...env, OIDC_ISSUER: "not a url" }, /OIDC_ISSUER/],
  ])("rejects %j", (partial, message) => {
    expect(() => parseOidcConfig(partial)).toThrow(message);
  });

  it("doesn't repeat the client secret in an error", () => {
    let message = "";
    try {
      parseOidcConfig({ ...env, OIDC_ISSUER: "ftp://x" });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("OIDC_ISSUER");
    expect(message).not.toContain("s3cr3t-value");
  });
});

describe("ssoIdentity", () => {
  const claims = { sub: "abc", email: "a@example.com", email_verified: true };

  it("takes a verified email and the subject", () => {
    expect(ssoIdentity(claims)).toEqual({
      ok: true,
      subject: "abc",
      email: "a@example.com",
    });
    expect(ssoIdentity({ ...claims, email_verified: "true" }).ok).toBe(true);
  });

  it.each([
    { ...claims, email_verified: false },
    { ...claims, email_verified: undefined },
    { ...claims, email: undefined },
    { ...claims, email: "not-an-email" },
    { ...claims, sub: "" },
    { ...claims, sub: 42 },
  ])("refuses %j", (bad) => {
    expect(ssoIdentity(bad as Record<string, unknown>)).toEqual({ ok: false });
  });
});
