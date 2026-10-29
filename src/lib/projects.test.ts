import { describe, expect, it } from "vitest";
import { parseProjectForm } from "./projects";

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

const valid = {
  name: "Sample App",
  slug: "sample-app",
  monthlyBudgetUsd: "100",
};

function errors(values: Record<string, string>) {
  const result = parseProjectForm(form(values));
  if (result.ok) throw new Error("expected validation to fail");
  return result.state.fieldErrors;
}

describe("parseProjectForm", () => {
  it("accepts valid values and trims them", () => {
    expect(
      parseProjectForm(
        form({
          name: "  Sample App ",
          slug: " sample-app ",
          monthlyBudgetUsd: " 99.5 ",
        }),
      ),
    ).toEqual({
      ok: true,
      values: {
        name: "Sample App",
        slug: "sample-app",
        monthlyBudgetUsd: "99.5",
      },
    });
  });

  it.each(["", "   "])("treats a budget of %j as no budget", (budget) => {
    const result = parseProjectForm(
      form({ ...valid, monthlyBudgetUsd: budget }),
    );
    expect(result.ok && result.values.monthlyBudgetUsd).toBeNull();
  });

  it.each(["0", "0.00", "100", "1234.5", "9999999999.99"])(
    "accepts the budget %j",
    (budget) => {
      expect(
        parseProjectForm(form({ ...valid, monthlyBudgetUsd: budget })).ok,
      ).toBe(true);
    },
  );

  it.each(["-1", "1.234", "abc", "1e3", "$100", "10000000000"])(
    "rejects the budget %j",
    (budget) => {
      expect(errors({ ...valid, monthlyBudgetUsd: budget })).toHaveProperty(
        "monthlyBudgetUsd",
      );
    },
  );

  it.each(["", "My App", "my_app", "-app", "app-", "my--app", "x".repeat(65)])(
    "rejects the slug %j",
    (slug) => {
      expect(errors({ ...valid, slug }).slug).toBeDefined();
    },
  );

  it("requires a name of at most 100 characters", () => {
    expect(errors({ ...valid, name: " " }).name).toBe("Name is required");
    expect(errors({ ...valid, name: "x".repeat(101) }).name).toBeDefined();
  });

  it("returns the submitted values so the form can be refilled", () => {
    const result = parseProjectForm(form({ ...valid, slug: "Bad Slug" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.state.values).toEqual({ ...valid, slug: "Bad Slug" });
    expect(result.state.fieldErrors.name).toBeUndefined();
  });

  it("treats missing fields as empty", () => {
    const fieldErrors = errors({});
    expect(fieldErrors.name).toBeDefined();
    expect(fieldErrors.slug).toBeDefined();
    expect(fieldErrors.monthlyBudgetUsd).toBeUndefined();
  });
});
