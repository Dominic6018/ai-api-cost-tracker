import { describe, expect, it } from "vitest";
import {
  dateBounds,
  decodeCursor,
  encodeCursor,
  parseUsageFilters,
  usageQuery,
} from "./usage-filters";

const id = "4f0c6c5e-2f7a-4b8e-9d1a-3c5e7f9a1b2c";
const cursor = { occurredAt: "2026-10-29T12:34:56.123456Z", id };

describe("cursors", () => {
  it("round-trip with microsecond precision", () => {
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it.each([
    "",
    "not-base64!",
    Buffer.from("2026-10-29T12:34:56Z|" + id).toString("base64url"),
    Buffer.from("2026-10-29T12:34:56.123456Z|not-a-uuid").toString("base64url"),
    Buffer.from("2026-13-45T99:99:99.000000Z|" + id).toString("base64url"),
    Buffer.from(`2026-10-29T12:34:56.123456Z|${id}|extra`).toString(
      "base64url",
    ),
  ])("rejects the tampered cursor %j", (value) => {
    expect(decodeCursor(value)).toBeUndefined();
  });
});

describe("parseUsageFilters", () => {
  it("reads every filter", () => {
    expect(
      parseUsageFilters({
        project: id,
        provider: "anthropic",
        model: " claude-sonnet-5-5 ",
        from: "2026-10-01",
        to: "2026-10-29",
        cursor: encodeCursor(cursor),
      }),
    ).toEqual({
      projectId: id,
      provider: "anthropic",
      model: "claude-sonnet-5-5",
      from: "2026-10-01",
      to: "2026-10-29",
      cursor,
    });
  });

  it("drops invalid values instead of failing", () => {
    expect(
      parseUsageFilters({
        project: "not-a-uuid",
        provider: "acme",
        model: "x".repeat(201),
        from: "yesterday",
        to: "2026-02-30",
        cursor: "garbage",
      }),
    ).toEqual({});
  });

  it("swaps a reversed date range", () => {
    expect(
      parseUsageFilters({ from: "2026-10-29", to: "2026-10-01" }),
    ).toMatchObject({ from: "2026-10-01", to: "2026-10-29" });
  });

  it("uses the first of repeated parameters", () => {
    expect(parseUsageFilters({ provider: ["openai", "google"] })).toEqual({
      provider: "openai",
    });
  });

  it("returns no filters for an empty query", () => {
    expect(parseUsageFilters({})).toEqual({});
  });
});

describe("dateBounds", () => {
  it("makes the end date inclusive by ending at the next UTC midnight", () => {
    const { start, end } = dateBounds({ from: "2026-10-01", to: "2026-10-31" });
    expect(start?.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(end?.toISOString()).toBe("2026-11-01T00:00:00.000Z");
  });

  it("leaves open ends undefined", () => {
    expect(dateBounds({})).toEqual({ start: undefined, end: undefined });
  });
});

describe("usageQuery", () => {
  it("builds a query string that parses back to the same filters", () => {
    const filters = {
      projectId: id,
      provider: "openai" as const,
      model: "gpt-4.1",
      from: "2026-10-01",
      to: "2026-10-29",
    };
    const query = usageQuery(filters, cursor);
    const params = Object.fromEntries(new URLSearchParams(query.slice(1)));
    expect(parseUsageFilters(params)).toEqual({ ...filters, cursor });
  });

  it("is empty without filters", () => {
    expect(usageQuery({})).toBe("");
  });
});
