import { describe, expect, it } from "vitest";
import { PRICE_TIERS, providerEnum } from "@/db/schema";
import {
  parsePriceForm,
  PRICE_FORM_TIERS,
  PRICE_PROVIDERS,
} from "./price-form";

const NOW = new Date("2026-11-06T12:00:00Z");

const valid = {
  provider: "anthropic",
  serviceTier: "standard",
  model: "claude-sonnet-5-5",
  inputPerMTokUsd: "2",
  outputPerMTokUsd: "10",
  effectiveFrom: "2026-12-01T00:00",
  sourceUrl: "https://platform.claude.com/docs/en/about-claude/pricing",
  checkedOn: "2026-11-06",
};

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

function errors(values: Record<string, string>) {
  const result = parsePriceForm(form(values), NOW);
  if (result.ok) throw new Error("expected validation to fail");
  return result.state.fieldErrors;
}

describe("parsePriceForm", () => {
  it("lists the same providers as the database", () => {
    expect([...PRICE_PROVIDERS]).toEqual(providerEnum.enumValues);
  });

  it("accepts a minimal price, trimming text and reading the time as UTC", () => {
    const result = parsePriceForm(
      form({ ...valid, model: " claude-sonnet-5-5 ", inputPerMTokUsd: " 2 " }),
      NOW,
    );
    expect(result).toEqual({
      ok: true,
      input: {
        provider: "anthropic",
        serviceTier: "standard",
        model: "claude-sonnet-5-5",
        inputPerMTokUsd: "2",
        outputPerMTokUsd: "10",
        cachedInputPerMTokUsd: null,
        cacheWritePerMTokUsd: null,
        cacheWrite1hPerMTokUsd: null,
        longContextThresholdTokens: null,
        longInputPerMTokUsd: null,
        longOutputPerMTokUsd: null,
        longCachedInputPerMTokUsd: null,
        longCacheWritePerMTokUsd: null,
        longCacheWrite1hPerMTokUsd: null,
        batchMultiplier: null,
        webSearchPer1kUsd: null,
        effectiveFrom: new Date("2026-12-01T00:00:00Z"),
        sourceUrl: valid.sourceUrl,
        checkedOn: "2026-11-06",
      },
    });
  });

  it("accepts cache rates and a full long-prompt tier", () => {
    const result = parsePriceForm(
      form({
        ...valid,
        cachedInputPerMTokUsd: "0.20",
        cacheWritePerMTokUsd: "2.50",
        longContextThresholdTokens: "200000",
        longInputPerMTokUsd: "4",
        longOutputPerMTokUsd: "15",
        longCachedInputPerMTokUsd: "0.40",
      }),
      NOW,
    );
    expect(result.ok && result.input).toMatchObject({
      cachedInputPerMTokUsd: "0.20",
      longContextThresholdTokens: 200000,
      longCacheWritePerMTokUsd: null,
    });
  });

  it("requires a source and a check date", () => {
    const fieldErrors = errors({ ...valid, sourceUrl: "", checkedOn: "" });
    expect(fieldErrors.sourceUrl).toMatch(/pricing page's URL/);
    expect(fieldErrors.checkedOn).toBeDefined();
  });

  it.each([
    ["sourceUrl", "ftp://example.com/prices"],
    ["sourceUrl", "javascript:alert(1)"],
    ["checkedOn", "2026-11-07"], // tomorrow
    ["checkedOn", "2026-02-30"],
    ["effectiveFrom", "2026-12-01"],
    ["effectiveFrom", "2026-13-01T00:00"],
    ["inputPerMTokUsd", "-1"],
    ["inputPerMTokUsd", "0.0000001"],
    ["inputPerMTokUsd", "1000000"],
    ["outputPerMTokUsd", ""],
    ["cachedInputPerMTokUsd", "abc"],
    ["model", "my model"],
    ["model", ""],
    ["provider", "azure"],
  ])("rejects %s = %j", (field, value) => {
    expect(errors({ ...valid, [field]: value })).toHaveProperty(field);
  });

  it.each([
    ["0.5", "0.5"],
    ["1", "1"],
    ["0.125", "0.125"],
    ["", null],
  ])("accepts the batch multiplier %j", (value, parsed) => {
    const result = parsePriceForm(
      form({ ...valid, batchMultiplier: value }),
      NOW,
    );
    expect(result.ok && result.input.batchMultiplier).toBe(parsed);
  });

  it.each([
    ["10", "10"],
    [" 12.5 ", "12.5"],
    ["", null],
  ])("accepts the web search price %j", (value, parsed) => {
    const result = parsePriceForm(
      form({ ...valid, webSearchPer1kUsd: value }),
      NOW,
    );
    expect(result.ok && result.input.webSearchPer1kUsd).toBe(parsed);
  });

  it.each(["-1", "$10", "1234567", "0.0000001"])(
    "rejects the web search price %j",
    (value) => {
      expect(errors({ ...valid, webSearchPer1kUsd: value })).toEqual({
        webSearchPer1kUsd: "Enter a USD amount per 1,000 searches, like 10",
      });
    },
  );

  it.each(["0", "1.5", "2", "0.0001", "-0.5", "50%"])(
    "rejects the batch multiplier %j",
    (value) => {
      expect(errors({ ...valid, batchMultiplier: value })).toHaveProperty(
        "batchMultiplier",
      );
    },
  );

  it("accepts 1-hour cache-write rates, which need a tier when long", () => {
    const result = parsePriceForm(
      form({
        ...valid,
        cacheWritePerMTokUsd: "2.50",
        cacheWrite1hPerMTokUsd: "4",
      }),
      NOW,
    );
    expect(result.ok && result.input.cacheWrite1hPerMTokUsd).toBe("4");
    expect(
      Object.keys(errors({ ...valid, longCacheWrite1hPerMTokUsd: "8" })).sort(),
    ).toEqual([
      "longContextThresholdTokens",
      "longInputPerMTokUsd",
      "longOutputPerMTokUsd",
    ]);
  });

  it("requires the threshold and both long rates for a tier", () => {
    const fieldErrors = errors({ ...valid, longCachedInputPerMTokUsd: "0.4" });
    expect(Object.keys(fieldErrors).sort()).toEqual([
      "longContextThresholdTokens",
      "longInputPerMTokUsd",
      "longOutputPerMTokUsd",
    ]);
    expect(
      errors({ ...valid, longContextThresholdTokens: "0" }),
    ).toHaveProperty("longContextThresholdTokens");
  });

  it("returns the submitted values so the form can be refilled", () => {
    const result = parsePriceForm(form({ ...valid, sourceUrl: "nope" }), NOW);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.state.values.sourceUrl).toBe("nope");
    expect(result.state.values.model).toBe("claude-sonnet-5-5");
    expect(result.state.values.cacheWritePerMTokUsd).toBe("");
  });
});

describe("parsePriceForm tiers", () => {
  it("lists the same tiers as the database", () => {
    expect([...PRICE_FORM_TIERS]).toEqual([...PRICE_TIERS]);
  });

  it("reads a flex or fast price, and rejects other tiers", () => {
    const fast = parsePriceForm(form({ ...valid, serviceTier: "fast" }), NOW);
    expect(fast.ok && fast.input.serviceTier).toBe("fast");
    for (const tier of ["batch", "priority", ""]) {
      expect(errors({ ...valid, serviceTier: tier })).toHaveProperty(
        "serviceTier",
      );
    }
  });

  it("only takes a batch multiplier on a standard price", () => {
    expect(
      errors({ ...valid, serviceTier: "flex", batchMultiplier: "0.5" }),
    ).toHaveProperty("batchMultiplier");
  });
});
