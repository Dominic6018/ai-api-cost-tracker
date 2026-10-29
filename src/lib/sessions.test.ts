import { describe, expect, it } from "vitest";
import {
  generateSessionToken,
  hashSessionToken,
  safeRedirectPath,
} from "./sessions";

describe("session tokens", () => {
  it("are 256-bit base64url strings that don't repeat", () => {
    const tokens = Array.from({ length: 100 }, generateSessionToken);
    expect(tokens[0]).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(new Set(tokens).size).toBe(100);
  });

  it("hash to hex SHA-256 that doesn't contain the token", () => {
    const token = generateSessionToken();
    const hash = hashSessionToken(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(hashSessionToken(token));
    expect(hash).not.toContain(token);
  });
});

describe("safeRedirectPath", () => {
  it.each(["/projects", "/projects/abc/edit", "/projects?tab=1"])(
    "allows the same-site path %j",
    (path) => {
      expect(safeRedirectPath(path)).toBe(path);
    },
  );

  it.each([
    undefined,
    "",
    "projects",
    "https://evil.example",
    "//evil.example",
    "/\\evil.example",
    "/projects\nSet-Cookie: x",
    ["/projects", "/other"],
  ])("falls back for %j", (next) => {
    expect(safeRedirectPath(next)).toBe("/overview");
  });
});
