import { describe, expect, it } from "vitest";
import { parseLoginForm } from "./login";

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

describe("parseLoginForm", () => {
  it("accepts an email and password, trimming the email", () => {
    expect(
      parseLoginForm(form({ email: " ada@example.com ", password: "pw" })),
    ).toEqual({ ok: true, email: "ada@example.com", password: "pw" });
  });

  it.each([
    { email: "not-an-email", password: "pw" },
    { email: "ada@example.com", password: "" },
    { email: "", password: "" },
    {},
  ])("rejects %o and keeps the email to refill", (values) => {
    const result = parseLoginForm(form(values as Record<string, string>));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.state.email).toBe((values as { email?: string }).email ?? "");
    expect(result.state.error).toBeDefined();
  });

  it("never echoes the password back", () => {
    const result = parseLoginForm(
      form({ email: "bad", password: "secret-value" }),
    );
    expect(JSON.stringify(result)).not.toContain("secret-value");
  });
});
