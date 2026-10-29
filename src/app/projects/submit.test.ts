import { describe, expect, it, vi } from "vitest";
import type { Project } from "@/db/schema";
import { submitProjectForm } from "./submit";

const project: Project = {
  id: "4f0c6c5e-2f7a-4b8e-9d1a-3c5e7f9a1b2c",
  name: "Sample App",
  slug: "sample-app",
  monthlyBudgetUsd: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

const valid = form({
  name: "Sample App",
  slug: "sample-app",
  monthlyBudgetUsd: "",
});

describe("submitProjectForm", () => {
  it("saves validated values", async () => {
    const save = vi.fn().mockResolvedValue({ ok: true, project });
    expect(await submitProjectForm(valid, save)).toEqual({ ok: true });
    expect(save).toHaveBeenCalledWith({
      name: "Sample App",
      slug: "sample-app",
      monthlyBudgetUsd: null,
    });
  });

  it("does not save invalid values", async () => {
    const save = vi.fn();
    const result = await submitProjectForm(
      form({ name: "", slug: "sample-app", monthlyBudgetUsd: "" }),
      save,
    );
    expect(result.ok).toBe(false);
    expect(save).not.toHaveBeenCalled();
  });

  it("shows a taken slug as an inline slug error", async () => {
    const save = vi.fn().mockResolvedValue({ ok: false, error: "slug_taken" });
    expect(await submitProjectForm(valid, save)).toEqual({
      ok: false,
      state: {
        values: {
          name: "Sample App",
          slug: "sample-app",
          monthlyBudgetUsd: "",
        },
        fieldErrors: { slug: "Another project already uses this slug" },
      },
    });
  });

  it("reports a project that no longer exists", async () => {
    const save = vi.fn().mockResolvedValue({ ok: false, error: "not_found" });
    const result = await submitProjectForm(valid, save);
    expect(result.ok === false && result.state.formError).toBe(
      "This project no longer exists",
    );
  });
});
