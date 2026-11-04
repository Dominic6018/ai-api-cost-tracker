import { describe, expect, it } from "vitest";
import { parseReportLimit, parseSpendQuery } from "./reports";

const now = new Date("2026-11-04T15:30:00Z");
const parse = (query: string) =>
  parseSpendQuery(new URLSearchParams(query), now);

describe("parseSpendQuery", () => {
  it("defaults to the last 30 UTC days, ending today, by day", () => {
    const result = parse("");
    expect(result.ok && result.query).toEqual({
      from: "2026-10-06",
      to: "2026-11-04",
      groupBy: "day",
      start: new Date("2026-10-06T00:00:00Z"),
      end: new Date("2026-11-05T00:00:00Z"),
    });
  });

  it("reads an inclusive date range and a grouping", () => {
    const result = parse("from=2026-10-01&to=2026-10-31&groupBy=customer");
    expect(result.ok && result.query).toMatchObject({
      groupBy: "customer",
      start: new Date("2026-10-01T00:00:00Z"),
      end: new Date("2026-11-01T00:00:00Z"),
    });
  });

  it("counts 30 days back from a given end date", () => {
    const result = parse("to=2026-03-31");
    expect(result.ok && result.query.from).toBe("2026-03-02");
  });

  it.each([
    ["an unknown grouping", "groupBy=week", "groupBy"],
    ["a malformed date", "from=2026-13-01", "from"],
    ["from after to", "from=2026-10-02&to=2026-10-01", "from"],
    ["more than 366 days", "from=2025-01-01&to=2026-01-02", "from"],
    ["an unknown parameter", "projectId=x", ""],
  ])("rejects %s", (_, query, field) => {
    const result = parse(query);
    expect(result.ok).toBe(false);
    if (!result.ok && field) expect(result.fieldErrors[field]).toBeDefined();
  });

  it("accepts exactly 366 days", () => {
    expect(parse("from=2025-01-01&to=2026-01-01").ok).toBe(true);
  });
});

describe("parseReportLimit", () => {
  it("defaults to 100 and accepts 1 to 500", () => {
    expect(parseReportLimit(null)).toEqual({ ok: true, limit: 100 });
    expect(parseReportLimit("1")).toEqual({ ok: true, limit: 1 });
    expect(parseReportLimit("500")).toEqual({ ok: true, limit: 500 });
  });

  it.each(["0", "501", "2.5", "ten", ""])("rejects %j", (value) => {
    expect(parseReportLimit(value).ok).toBe(false);
  });
});
