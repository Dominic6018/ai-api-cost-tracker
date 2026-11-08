import { describe, expect, it } from "vitest";
import { DEFAULT_ORGANIZATION_ID } from "@/db/schema";
import { can } from "./roles";

const inDefault = (role: "admin" | "member" | "viewer") => ({
  role,
  organizationId: DEFAULT_ORGANIZATION_ID,
});

describe("can", () => {
  it.each([
    ["admin", "projects:manage", true],
    ["admin", "prices:manage", true],
    ["member", "projects:manage", true],
    ["member", "prices:manage", false],
    ["viewer", "projects:manage", false],
    ["viewer", "prices:manage", false],
    ["admin", "audit:read", true],
    ["member", "audit:read", false],
    ["viewer", "audit:read", false],
  ] as const)("%s, %s: %s", (role, permission, allowed) => {
    expect(can(inDefault(role), permission)).toBe(allowed);
  });

  describe("in another organization", () => {
    const admin = {
      role: "admin" as const,
      organizationId: "4f0c6c5e-2f7a-4b8e-9d1a-3c5e7f9a1b2c",
    };

    it("manages its own projects and reads its audit log", () => {
      expect(can(admin, "projects:manage")).toBe(true);
      expect(can(admin, "audit:read")).toBe(true);
    });

    it("can't change prices, even as an admin", () => {
      expect(can(admin, "prices:manage")).toBe(false);
    });
  });
});
