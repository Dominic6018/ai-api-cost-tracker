import { describe, expect, it, vi } from "vitest";
import type { ModelPricing } from "@/db/schema";
import { submitEndPriceForm } from "./submit-end";

const NOW = new Date("2026-11-06T12:00:00Z");

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

const valid = {
  endsAt: "2027-01-01T00:00",
  sourceUrl: "https://developers.openai.com/api/docs/deprecations",
  checkedOn: "2026-11-06",
};

describe("submitEndPriceForm", () => {
  it("saves the end with its provenance", async () => {
    const save = vi
      .fn()
      .mockResolvedValue({ ok: true, price: {} as ModelPricing });
    expect(await submitEndPriceForm(form(valid), save, NOW)).toEqual({
      ok: true,
    });
    expect(save).toHaveBeenCalledWith({
      endsAt: new Date("2027-01-01T00:00:00Z"),
      sourceUrl: valid.sourceUrl,
      checkedOn: "2026-11-06",
    });
  });

  it("doesn't save without a source", async () => {
    const save = vi.fn();
    const result = await submitEndPriceForm(
      form({ ...valid, sourceUrl: "" }),
      save,
      NOW,
    );
    expect(result.ok).toBe(false);
    expect(save).not.toHaveBeenCalled();
  });

  it("shows an end outside the price's range on its field", async () => {
    const save = vi.fn().mockResolvedValue({ ok: false, error: "invalid_end" });
    const result = await submitEndPriceForm(form(valid), save, NOW);
    expect(result).toEqual({
      ok: false,
      state: {
        values: valid,
        fieldErrors: {
          endsAt: expect.stringMatching(/after this price starts/),
        },
      },
    });
  });

  it("says when the price no longer exists", async () => {
    const save = vi.fn().mockResolvedValue({ ok: false, error: "not_found" });
    const result = await submitEndPriceForm(form(valid), save, NOW);
    expect(result.ok === false && result.state.formError).toBe(
      "This price no longer exists",
    );
  });
});
