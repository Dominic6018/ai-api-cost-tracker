import { describe, expect, it } from "vitest";
import { parseRole, parseTeamStatus } from "./team";

describe("parseRole", () => {
  it("reads the three roles and nothing else", () => {
    for (const role of ["admin", "member", "viewer"]) {
      expect(parseRole(role)).toBe(role);
    }
    for (const value of ["owner", "Admin", "", null, new File([], "admin")]) {
      expect(parseRole(value)).toBeNull();
    }
  });
});

describe("parseTeamStatus", () => {
  it("reads known statuses only", () => {
    expect(parseTeamStatus("last_admin")).toBe("last_admin");
    expect(parseTeamStatus("changed")).toBe("changed");
    for (const value of [undefined, "", "toString", ["changed"], "<b>"]) {
      expect(parseTeamStatus(value)).toBeNull();
    }
  });
});
