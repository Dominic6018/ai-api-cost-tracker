import { describe, expect, it } from "vitest";
import {
  formatTagFilter,
  isValidTag,
  parseTagFilter,
  tagsSchema,
} from "./tags";

describe("tagsSchema", () => {
  it("accepts string labels and trims values", () => {
    expect(
      tagsSchema.parse({ env: " prod ", "team/search": "a", "v1.2_x-y": "b" }),
    ).toEqual({ env: "prod", "team/search": "a", "v1.2_x-y": "b" });
  });

  it("accepts exactly 20 tags and rejects 21", () => {
    const tags = (n: number) =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, "v"]));
    expect(tagsSchema.safeParse(tags(20)).success).toBe(true);
    expect(tagsSchema.safeParse(tags(21)).success).toBe(false);
  });

  it.each([
    ["a key with a colon", { "k8s:ns": "a" }],
    ["a key with a space", { "my tag": "a" }],
    ["an empty key", { "": "a" }],
    ["a 65-character key", { ["k".repeat(65)]: "a" }],
    ["an empty value", { env: "  " }],
    ["a 201-character value", { env: "v".repeat(201) }],
    ["a number value", { env: 1 }],
    ["a nested value", { env: { a: "b" } }],
    ["an attribution name", { customerId: "cus_42" }],
    ["another attribution name", { runId: "r1" }],
  ])("rejects %s", (_, tags) => {
    expect(tagsSchema.safeParse(tags).success).toBe(false);
  });

  it("rejects a __proto__ key instead of silently dropping it", () => {
    // JSON.parse makes __proto__ an own key, as a request body would.
    const result = tagsSchema.safeParse(
      JSON.parse('{"__proto__": "b", "env": "prod"}'),
    );
    expect(result.success).toBe(false);
    expect(tagsSchema.parse({ constructor: "a" })).toEqual({
      constructor: "a",
    });
  });
});

describe("isValidTag", () => {
  it("agrees with tagsSchema for one tag", () => {
    const cases: [string, string][] = [
      ["env", "prod"],
      ["team/search.v1_x-y", "a"],
      ["k8s:ns", "a"],
      ["my tag", "a"],
      ["", "a"],
      ["k".repeat(65), "a"],
      ["feature", "a"],
      ["constructor", "a"],
      ["env", ""],
      ["env", "v".repeat(200)],
      ["env", "v".repeat(201)],
    ];
    for (const [key, value] of cases) {
      expect(isValidTag(key, value), `${key}=${value}`).toBe(
        tagsSchema.safeParse({ [key]: value }).success,
      );
    }
  });
});

describe("parseTagFilter", () => {
  it("splits at the first colon, so values may contain colons", () => {
    expect(parseTagFilter("env:prod")).toEqual({ key: "env", value: "prod" });
    expect(parseTagFilter(" url : https://x.example/a ")).toEqual({
      key: "url",
      value: "https://x.example/a",
    });
  });

  it.each([
    "",
    "env",
    ":prod",
    "env:",
    "my env:prod",
    "env:" + "v".repeat(201),
  ])("rejects %j", (text) => {
    expect(parseTagFilter(text)).toBeUndefined();
  });

  it("round-trips through formatTagFilter", () => {
    const tag = { key: "team", value: "search:core" };
    expect(parseTagFilter(formatTagFilter(tag))).toEqual(tag);
  });
});
