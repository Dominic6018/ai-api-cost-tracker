import { describe, expect, it, vi } from "vitest";
import {
  dollarsToMicros,
  fetchOpenAICosts,
  OpenAICostsError,
  parseOpenAICostsPage,
} from "./openai-costs";

// The example response from OpenAI's API reference for the costs endpoint.
const DOCUMENTED_PAGE = {
  object: "page",
  data: [
    {
      object: "bucket",
      start_time: 1730419200,
      end_time: 1730505600,
      results: [
        {
          object: "organization.costs.result",
          amount: { value: 0.06, currency: "usd" },
          line_item: null,
          project_id: null,
        },
      ],
    },
  ],
  has_more: false,
  next_page: null,
};

describe("dollarsToMicros", () => {
  it.each([
    [0.06, 60_000n],
    [0.1 + 0.2, 300_000n], // float noise rounds away
    [1234.567891, 1_234_567_891n],
    [0.0000004, 0n],
    [0.0000005, 1n],
    [-1.5, -1_500_000n], // credits
    [0, 0n],
  ])("$%s is %s micro-dollars", (dollars, micros) => {
    expect(dollarsToMicros(dollars)).toBe(micros);
  });

  it("rejects non-finite values", () => {
    expect(() => dollarsToMicros(Number.NaN)).toThrow(TypeError);
    expect(() => dollarsToMicros(Infinity)).toThrow(TypeError);
  });
});

describe("parseOpenAICostsPage", () => {
  it("reads the documented response; start_time is Unix seconds", () => {
    expect(parseOpenAICostsPage(DOCUMENTED_PAGE)).toEqual({
      // 1730419200 is 2024-11-01T00:00:00Z
      costs: [{ day: "2024-11-01", lineItem: null, micros: 60_000n }],
      nextPage: null,
    });
  });

  it("keeps line items, empty buckets and the next page", () => {
    const page = {
      data: [
        {
          start_time: 1793664000, // 2026-11-03
          results: [
            {
              amount: { value: 0.002, currency: "usd" },
              line_item: "gpt-4.1, input",
            },
            {
              amount: { value: 0.04, currency: "USD" },
              line_item: "Image models",
            },
          ],
        },
        { start_time: 1793750400, results: [] },
      ],
      has_more: true,
      next_page: "page_2",
    };
    expect(parseOpenAICostsPage(page)).toEqual({
      costs: [
        { day: "2026-11-03", lineItem: "gpt-4.1, input", micros: 2_000n },
        { day: "2026-11-03", lineItem: "Image models", micros: 40_000n },
      ],
      nextPage: "page_2",
    });
  });

  it.each([
    ["no data", {}],
    ["a bucket without start_time", { data: [{ results: [] }] }],
    [
      "a result without an amount",
      { data: [{ start_time: 1, results: [{ line_item: "x" }] }] },
    ],
    [
      "an amount that's a string",
      { data: [{ start_time: 1, results: [{ amount: { value: "0.06" } }] }] },
    ],
    [
      "another currency",
      {
        data: [
          {
            start_time: 1,
            results: [{ amount: { value: 1, currency: "eur" } }],
          },
        ],
      },
    ],
  ])("rejects a page with %s", (_, page) => {
    expect(() => parseOpenAICostsPage(page)).toThrow(TypeError);
  });
});

describe("fetchOpenAICosts", () => {
  const from = new Date("2026-10-01T00:00:00Z");
  const to = new Date("2026-11-01T00:00:00Z");
  const page = (start: number, value: number, next: string | null) => ({
    object: "page",
    data: [
      {
        start_time: start,
        results: [{ amount: { value, currency: "usd" }, line_item: "x" }],
      },
    ],
    has_more: next !== null,
    next_page: next,
  });

  it("requests daily costs by line item and follows pagination", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json(page(1790812800, 1, "p2")))
      .mockResolvedValueOnce(Response.json(page(1790899200, 2, null)));
    const costs = await fetchOpenAICosts({
      adminKey: "sk-admin-test",
      from,
      to,
      fetch,
    });
    expect(costs.map((c) => [c.day, c.micros])).toEqual([
      ["2026-10-01", 1_000_000n],
      ["2026-10-02", 2_000_000n],
    ]);

    const [url, init] = fetch.mock.calls[0] as [URL, RequestInit];
    expect(url.origin + url.pathname).toBe(
      "https://api.openai.com/v1/organization/costs",
    );
    expect(url.searchParams.get("start_time")).toBe("1790812800");
    expect(url.searchParams.get("end_time")).toBe("1793491200");
    expect(url.searchParams.get("bucket_width")).toBe("1d");
    expect(url.searchParams.getAll("group_by")).toEqual(["line_item"]);
    expect((init.headers as Record<string, string>).authorization).toBe(
      "Bearer sk-admin-test",
    );
    expect((fetch.mock.calls[1] as [URL])[0].searchParams.get("page")).toBe(
      "p2",
    );
  });

  it("explains that an Admin key is needed when one is rejected", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        Response.json(
          { error: { message: "Insufficient permissions" } },
          { status: 403 },
        ),
      );
    const error = await fetchOpenAICosts({
      adminKey: "sk-proj-regular",
      from,
      to,
      fetch,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpenAICostsError);
    expect(error).toMatchObject({ status: 403 });
    expect((error as Error).message).toMatch(/Admin key/);
  });
});
