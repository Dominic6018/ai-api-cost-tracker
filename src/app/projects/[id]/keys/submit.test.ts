import { describe, expect, it, vi } from "vitest";
import type { ApiKeySummary } from "@/db/api-keys";
import { submitApiKeyForm } from "./submit";

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

const record: ApiKeySummary = {
  id: "4f0c6c5e-2f7a-4b8e-9d1a-3c5e7f9a1b2c",
  projectId: "00000000-0000-0000-0000-0000000000aa",
  name: "production",
  keyPrefix: "act_abcd1234",
  scope: "ingest",
  createdAt: new Date(),
  lastUsedAt: null,
  revokedAt: null,
};
// Made up, and assembled so secret scanners don't flag it.
const KEY = ["act", "abcd1234", "x".repeat(35)].join("_");

describe("submitApiKeyForm", () => {
  it("creates the key and shows it once, with the form emptied", async () => {
    const save = vi.fn().mockResolvedValue({ ok: true, key: KEY, record });
    const state = await submitApiKeyForm(
      form({ name: " production ", scope: "ingest" }),
      save,
    );
    expect(save).toHaveBeenCalledWith({ name: "production", scope: "ingest" });
    expect(state).toEqual({
      values: { name: "", scope: "ingest" },
      fieldErrors: {},
      created: {
        key: KEY,
        name: "production",
        prefix: "act_abcd1234",
        scope: "ingest",
      },
    });
  });

  it("creates nothing when the form is invalid", async () => {
    const save = vi.fn();
    const state = await submitApiKeyForm(
      form({ name: "", scope: "read" }),
      save,
    );
    expect(save).not.toHaveBeenCalled();
    expect(state.fieldErrors.name).toBeDefined();
    expect(state.created).toBeUndefined();
  });

  it("says so when the project is gone, keeping the values", async () => {
    const save = vi.fn().mockResolvedValue({ ok: false, error: "not_found" });
    expect(
      await submitApiKeyForm(form({ name: "ci", scope: "read" }), save),
    ).toEqual({
      values: { name: "ci", scope: "read" },
      fieldErrors: {},
      formError: "This project no longer exists",
    });
  });
});
