import { describe, expect, it } from "vitest";
import {
  generateInvitationToken,
  hashInvitationToken,
  invitationUrl,
  isWellFormedInvitationToken,
  parseAcceptForm,
  parseInviteForm,
} from "./invitations";

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

describe("invitation tokens", () => {
  it("are 256-bit, well formed, and stored only as a hash", () => {
    const a = generateInvitationToken();
    const b = generateInvitationToken();
    expect(a.token).not.toBe(b.token);
    expect(isWellFormedInvitationToken(a.token)).toBe(true);
    expect(a.hash).toBe(hashInvitationToken(a.token));
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.hash).not.toContain(a.token);
    for (const bad of ["", "short", `${a.token}x`, `${a.token.slice(1)}!`]) {
      expect(isWellFormedInvitationToken(bad), bad).toBe(false);
    }
  });

  it("make a link on the request's own host", () => {
    const token = "t".repeat(43);
    expect(
      invitationUrl(token, { host: "costs.example.com", proto: null }),
    ).toBe(`https://costs.example.com/invite/${token}`);
    expect(invitationUrl(token, { host: "localhost:3000", proto: null })).toBe(
      `http://localhost:3000/invite/${token}`,
    );
    expect(
      invitationUrl(token, { host: "costs.example.com", proto: "https, http" }),
    ).toBe(`https://costs.example.com/invite/${token}`);
  });
});

describe("parseInviteForm", () => {
  it("reads a lowercased email and a role", () => {
    expect(
      parseInviteForm(
        form({ email: " New.Person@Example.com ", role: "viewer" }),
      ),
    ).toEqual({
      ok: true,
      values: { email: "new.person@example.com", role: "viewer" },
    });
  });

  it("refuses a bad email or role, keeping what was typed", () => {
    expect(parseInviteForm(form({ email: "nope", role: "owner" }))).toEqual({
      ok: false,
      state: {
        values: { email: "nope", role: "owner" },
        fieldErrors: {
          email: "Enter an email address",
          role: "Choose admin, member or viewer",
        },
      },
    });
  });
});

describe("parseAcceptForm", () => {
  const strong = "a long enough password";

  it("takes a long enough password typed twice", () => {
    expect(
      parseAcceptForm(form({ password: strong, confirmPassword: strong })),
    ).toEqual({ ok: true, password: strong });
  });

  it("refuses a short, overlong or mismatched password", () => {
    for (const values of [
      { password: "short", confirmPassword: "short" },
      { password: "x".repeat(257), confirmPassword: "x".repeat(257) },
      { password: strong, confirmPassword: `${strong}!` },
      {},
    ]) {
      const result = parseAcceptForm(form(values as Record<string, string>));
      expect(result.ok).toBe(false);
      expect(!result.ok && result.state.error).toBeTruthy();
    }
  });
});
