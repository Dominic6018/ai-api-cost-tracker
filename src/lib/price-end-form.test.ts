import { describe, expect, it } from "vitest";
import { parseEndPriceForm } from "./price-end-form";

const NOW = new Date("2026-11-06T12:00:00Z");

const valid = {
  endsAt: "2027-01-01T00:00",
  sourceUrl:
    "https://platform.claude.com/docs/en/about-claude/model-deprecations",
  checkedOn: "2026-11-06",
};

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

function errors(values: Record<string, string>) {
  const result = parseEndPriceForm(form(values), NOW);
  if (result.ok) throw new Error("expected validation to fail");
  return result.state.fieldErrors;
}

describe("parseEndPriceForm", () => {
  it("reads the end as UTC, with its provenance", () => {
    expect(parseEndPriceForm(form(valid), NOW)).toEqual({
      ok: true,
      input: {
        endsAt: new Date("2027-01-01T00:00:00Z"),
        sourceUrl: valid.sourceUrl,
        checkedOn: "2026-11-06",
      },
    });
  });

  it("requires a source and a check date for the end too", () => {
    const fieldErrors = errors({ ...valid, sourceUrl: "", checkedOn: "" });
    expect(fieldErrors.sourceUrl).toMatch(/Where was the end announced/);
    expect(fieldErrors.checkedOn).toBeDefined();
  });

  it.each([
    ["endsAt", ""],
    ["endsAt", "2027-02-30T00:00"],
    ["sourceUrl", "mailto:support@example.com"],
    ["checkedOn", "2026-11-07"],
  ])("rejects %s = %j", (field, value) => {
    expect(errors({ ...valid, [field]: value })).toHaveProperty(field);
  });

  it("returns the submitted values so the form can be refilled", () => {
    const result = parseEndPriceForm(form({ ...valid, sourceUrl: "x" }), NOW);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.state.values).toEqual({ ...valid, sourceUrl: "x" });
  });
});
