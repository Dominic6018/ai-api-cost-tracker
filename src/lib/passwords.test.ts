import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./passwords";

describe("password hashing", () => {
  it("verifies the original password and rejects others", async () => {
    const hash = await hashPassword("correct horse battery");
    expect(await verifyPassword("correct horse battery", hash)).toBe(true);
    expect(await verifyPassword("correct horse batterY", hash)).toBe(false);
    expect(await verifyPassword("", hash)).toBe(false);
  });

  it("stores scrypt parameters and a random salt, never the password", async () => {
    const [a, b] = await Promise.all([
      hashPassword("same password here"),
      hashPassword("same password here"),
    ]);
    expect(a).toMatch(/^scrypt\$32768\$8\$3\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
    expect(a).not.toBe(b);
    expect(a).not.toContain("same password here");
  });

  it.each([
    "",
    "plain-text-password",
    "bcrypt$10$abc$def$ghi$jkl",
    "scrypt$0$8$3$c2FsdA$aGFzaA",
    "scrypt$32768$8$3$c2FsdA$dG9vLXNob3J0",
  ])("rejects the malformed stored hash %j", async (stored) => {
    expect(await verifyPassword("anything", stored)).toBe(false);
  });
});
