import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_ORGANIZATION_ID } from "@/db/schema";
import { NAV_SECTIONS, navigationFor } from "./navigation";

const account = (role: "admin" | "member" | "viewer") => ({
  role,
  organizationId: DEFAULT_ORGANIZATION_ID,
});

describe("navigationFor", () => {
  it("shows the roadmap's sections in order, with Team for admins", () => {
    expect(
      navigationFor(account("admin"), "/overview").map((s) => s.label),
    ).toEqual([
      "Overview",
      "Usage",
      "Insights",
      "Customers",
      "Budgets",
      "Prices",
      "Integrations",
      "Team",
    ]);
  });

  it("hides accounts and the audit log, and so Team, from members and viewers", () => {
    for (const role of ["member", "viewer"] as const) {
      const sections = navigationFor(account(role), "/overview");
      expect(sections.map((s) => s.label)).not.toContain("Team");
      const hrefs = sections.flatMap((s) => s.links.map((l) => l.href));
      expect(hrefs).not.toContain("/audit");
      expect(hrefs).not.toContain("/team");
    }
  });

  it("marks the section holding the current page", () => {
    const sections = navigationFor(account("viewer"), "/spend");
    expect(sections.filter((s) => s.active).map((s) => s.label)).toEqual([
      "Usage",
    ]);
    // A page outside every section marks none.
    expect(
      navigationFor(account("viewer"), "/elsewhere").some((s) => s.active),
    ).toBe(false);
  });

  it("links only to pages that exist, each once", () => {
    const hrefs = NAV_SECTIONS.flatMap((s) => s.links.map((l) => l.href));
    expect(new Set(hrefs).size).toBe(hrefs.length);
    for (const href of hrefs) {
      expect(existsSync(`src/app${href}/page.tsx`), href).toBe(true);
    }
  });
});
