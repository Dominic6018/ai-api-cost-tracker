import { describe, expect, it } from "vitest";
import { can } from "./roles";

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
    expect(can(role, permission)).toBe(allowed);
  });
});
