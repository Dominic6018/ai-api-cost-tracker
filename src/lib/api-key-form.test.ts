import { describe, expect, it } from "vitest";
import { parseApiKeyForm } from "./api-key-form";

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

describe("parseApiKeyForm", () => {
  it("reads a trimmed name and either scope", () => {
    expect(
      parseApiKeyForm(form({ name: " production ", scope: "ingest" })),
    ).toEqual({ ok: true, values: { name: "production", scope: "ingest" } });
    expect(parseApiKeyForm(form({ name: "grafana", scope: "read" }))).toEqual({
      ok: true,
      values: { name: "grafana", scope: "read" },
    });
  });

  it("refuses an empty or long name, keeping what was typed", () => {
    expect(parseApiKeyForm(form({ name: "   ", scope: "read" }))).toEqual({
      ok: false,
      state: {
        values: { name: "   ", scope: "read" },
        fieldErrors: { name: "Name is required, e.g. production or ci" },
      },
    });
    const long = "k".repeat(101);
    const result = parseApiKeyForm(form({ name: long, scope: "ingest" }));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.state.fieldErrors.name).toBe(
      "Name must be at most 100 characters",
    );
    expect(
      parseApiKeyForm(form({ name: "k".repeat(100), scope: "ingest" })).ok,
    ).toBe(true);
  });

  it("refuses a missing or unknown scope", () => {
    for (const values of [
      { name: "x" },
      { name: "x", scope: "admin" },
    ] as Record<string, string>[]) {
      const result = parseApiKeyForm(form(values));
      expect(result.ok).toBe(false);
      expect(!result.ok && result.state.fieldErrors).toEqual({
        scope: "Choose what the key may do",
      });
    }
  });
});
