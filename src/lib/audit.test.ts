import { describe, expect, it } from "vitest";
import type { ModelPricing, Project } from "@/db/schema";
import {
  formatAuditDetails,
  parseAuditPage,
  priceAddedEntry,
  priceEndedEntry,
  projectCreatedEntry,
  projectUpdatedEntry,
} from "./audit";

const project = {
  id: "p1",
  name: "Support Bot",
  slug: "support-bot",
  monthlyBudgetUsd: "100.00",
  runBudgetUsd: null,
} as Project;

const price = {
  provider: "openai",
  model: "gpt-5.5",
  serviceTier: "flex",
  inputPerMTokUsd: "2.500000",
  outputPerMTokUsd: "15.000000",
  effectiveFrom: new Date("2026-11-08T00:00:00Z"),
  effectiveTo: new Date("2026-12-01T00:00:00Z"),
  sourceUrl: "https://example.com/pricing",
  endSourceUrl: "https://example.com/retired",
} as ModelPricing;

describe("project entries", () => {
  it("records a new project", () => {
    expect(projectCreatedEntry(project)).toEqual({
      action: "project.created",
      target: "support-bot",
      details: {
        name: "Support Bot",
        monthlyBudgetUsd: "100.00",
        runBudgetUsd: null,
      },
    });
  });

  it("records only the fields that changed", () => {
    expect(
      projectUpdatedEntry(project, {
        ...project,
        name: "Helpdesk",
        monthlyBudgetUsd: null,
      }),
    ).toEqual({
      action: "project.updated",
      target: "support-bot",
      details: {
        name: { from: "Support Bot", to: "Helpdesk" },
        monthlyBudgetUsd: { from: "100.00", to: null },
      },
    });
  });

  it("records nothing when saving changed nothing", () => {
    expect(projectUpdatedEntry(project, { ...project })).toBeNull();
  });
});

describe("price entries", () => {
  it("names the provider, model and tier", () => {
    expect(priceAddedEntry(price)).toEqual({
      action: "price.added",
      target: "openai gpt-5.5 (flex)",
      details: {
        effectiveFrom: "2026-11-08T00:00:00.000Z",
        inputPerMTokUsd: "2.500000",
        outputPerMTokUsd: "15.000000",
        source: "https://example.com/pricing",
      },
    });
  });

  it("records when a price ends and why", () => {
    expect(priceEndedEntry(price).details).toEqual({
      endsAt: "2026-12-01T00:00:00.000Z",
      source: "https://example.com/retired",
    });
  });
});

describe("formatAuditDetails", () => {
  it("shows changes and plain values, one per line", () => {
    expect(
      formatAuditDetails({
        monthlyBudgetUsd: { from: "100.00", to: null },
        scope: "read",
      }),
    ).toEqual(["monthlyBudgetUsd: 100.00 → none", "scope: read"]);
  });

  it("has nothing to show without details", () => {
    expect(formatAuditDetails(null)).toEqual([]);
  });
});

describe("parseAuditPage", () => {
  it("reads a page number", () => {
    expect(parseAuditPage("3")).toBe(3);
  });

  it.each([undefined, "", "0", "-1", "1.5", "abc", "99999999", ["2"]])(
    "treats %j as the first page",
    (value) => {
      expect(parseAuditPage(value)).toBe(1);
    },
  );
});
