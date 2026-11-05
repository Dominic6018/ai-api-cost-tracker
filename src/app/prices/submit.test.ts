import { describe, expect, it, vi } from "vitest";
import type { ModelPricing } from "@/db/schema";
import { submitPriceForm } from "./submit";

const NOW = new Date("2026-11-06T12:00:00Z");

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

const valid = {
  provider: "openai",
  model: "gpt-4.1",
  inputPerMTokUsd: "2",
  outputPerMTokUsd: "8",
  effectiveFrom: "2026-12-01T00:00",
  sourceUrl: "https://developers.openai.com/api/docs/pricing",
  checkedOn: "2026-11-06",
};

describe("submitPriceForm", () => {
  it("saves validated input", async () => {
    const save = vi.fn().mockResolvedValue({
      ok: true,
      price: {} as ModelPricing,
      ended: 1,
    });
    expect(await submitPriceForm(form(valid), save, NOW)).toEqual({ ok: true });
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        model: "gpt-4.1",
        effectiveFrom: new Date("2026-12-01T00:00:00Z"),
        sourceUrl: valid.sourceUrl,
        checkedOn: "2026-11-06",
      }),
    );
  });

  it("doesn't save without a source", async () => {
    const save = vi.fn();
    const result = await submitPriceForm(
      form({ ...valid, sourceUrl: "" }),
      save,
      NOW,
    );
    expect(result.ok).toBe(false);
    expect(save).not.toHaveBeenCalled();
  });

  it("shows a duplicate start time on its field, refilling the form", async () => {
    const save = vi
      .fn()
      .mockResolvedValue({ ok: false, error: "duplicate_start" });
    const result = await submitPriceForm(form(valid), save, NOW);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.state.fieldErrors).toEqual({
      effectiveFrom: expect.stringMatching(/already has a price starting/),
    });
    expect(result.state.values).toMatchObject({
      model: "gpt-4.1",
      sourceUrl: valid.sourceUrl,
      cachedInputPerMTokUsd: "",
    });
  });
});
