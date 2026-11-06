import { describe, expect, it, vi } from "vitest";
import {
  CostReportError,
  fetchAnthropicCostReport,
} from "./anthropic-cost-report";
import {
  centsToMicros,
  formatMicros,
  parseAnthropicCostReport,
  reconcile,
  type BilledCost,
} from "./reconcile";

// The example response from Anthropic's cost report reference.
const DOCUMENTED_PAGE = {
  data: [
    {
      ending_at: "2025-08-02T00:00:00Z",
      results: [
        {
          amount: "123.78912",
          context_window: "0-200k",
          cost_type: "tokens",
          currency: "USD",
          description: "Claude Opus 5.5 Usage - Input Tokens",
          inference_geo: "global",
          model: "claude-opus-5-5",
          service_tier: "standard",
          speed: "standard",
          token_type: "cache_creation.ephemeral_1h_input_tokens",
          workspace_id: "wrkspc_01JwQvzr7rXLA5AGx3HKfFUJ",
        },
      ],
      starting_at: "2025-08-01T00:00:00Z",
    },
  ],
  has_more: true,
  next_page: "page_MjAyNS0wNS0xNFQwMDowMDowMFo=",
};

describe("centsToMicros", () => {
  it.each([
    ["123.45", 1_234_500n], // the docs' example: $1.2345
    ["123.78912", 1_237_891n], // rounds the fifth cent decimal
    ["0.00005", 1n], // half a micro-dollar rounds up
    ["0.00004", 0n],
    ["8.375", 83_750n],
    ["0", 0n],
    ["100", 1_000_000n],
    ["-2.50005", -25_001n], // credits round away from zero too
  ])("%s cents is %s micro-dollars", (cents, micros) => {
    expect(centsToMicros(cents)).toBe(micros);
  });

  it.each(["", "1e3", "12.", "$1", "1,000"])("rejects %j", (bad) => {
    expect(() => centsToMicros(bad)).toThrow(TypeError);
  });
});

describe("parseAnthropicCostReport", () => {
  it("reads the documented response", () => {
    expect(parseAnthropicCostReport(DOCUMENTED_PAGE)).toEqual({
      costs: [
        {
          day: "2025-08-01",
          model: "claude-opus-5-5",
          costType: "tokens",
          micros: 1_237_891n,
        },
      ],
      nextPage: "page_MjAyNS0wNS0xNFQwMDowMDowMFo=",
    });
  });

  it("keeps non-token costs, which have no model, and empty buckets", () => {
    const page = {
      data: [
        {
          starting_at: "2026-11-01T00:00:00Z",
          results: [
            {
              amount: "50",
              currency: "USD",
              cost_type: "web_search",
              model: null,
            },
          ],
        },
        { starting_at: "2026-11-02T00:00:00Z", results: [] },
      ],
      has_more: false,
      next_page: null,
    };
    expect(parseAnthropicCostReport(page)).toEqual({
      costs: [
        {
          day: "2026-11-01",
          model: null,
          costType: "web_search",
          micros: 500_000n,
        },
      ],
      nextPage: null,
    });
  });

  it.each([
    ["no data", {}],
    ["a bucket without a start", { data: [{ results: [] }] }],
    [
      "an amount that isn't a string",
      {
        data: [
          { starting_at: "2026-11-01T00:00:00Z", results: [{ amount: 1.5 }] },
        ],
      },
    ],
    [
      "another currency",
      {
        data: [
          {
            starting_at: "2026-11-01T00:00:00Z",
            results: [{ amount: "1", currency: "EUR" }],
          },
        ],
      },
    ],
  ])("rejects a report with %s", (_, page) => {
    expect(() => parseAnthropicCostReport(page)).toThrow(TypeError);
  });
});

describe("reconcile", () => {
  const tokens = (day: string, model: string, micros: bigint): BilledCost => ({
    day,
    model,
    costType: "tokens",
    micros,
  });

  it("sums token types per day and model and compares them", () => {
    const report = reconcile(
      [
        // Input and output arrive as separate rows in the report.
        tokens("2026-11-01", "claude-sonnet-5-5", 600_000n),
        tokens("2026-11-01", "claude-sonnet-5-5", 400_000n),
        tokens("2026-11-01", "claude-haiku-5-5", 83_750n),
      ],
      [
        {
          day: "2026-11-01",
          model: "claude-sonnet-5-5",
          micros: 1_000_000n,
          webSearchMicros: 0n,
        },
        {
          day: "2026-11-01",
          model: "claude-haiku-5-5",
          micros: 83_750n,
          webSearchMicros: 0n,
        },
      ],
    );
    expect(report.rows).toEqual([
      {
        day: "2026-11-01",
        model: "claude-haiku-5-5",
        billedMicros: 83_750n,
        recordedMicros: 83_750n,
        diffMicros: 0n,
        flagged: false,
      },
      {
        day: "2026-11-01",
        model: "claude-sonnet-5-5",
        billedMicros: 1_000_000n,
        recordedMicros: 1_000_000n,
        diffMicros: 0n,
        flagged: false,
      },
    ]);
    expect(report.totals).toEqual({
      billedMicros: 1_083_750n,
      recordedMicros: 1_083_750n,
      diffMicros: 0n,
    });
  });

  it("flags differences beyond the tolerance, and at least a cent", () => {
    const report = reconcile(
      [
        tokens("2026-11-01", "a", 1_000_000n), // $1.00 billed
        tokens("2026-11-01", "b", 1_000_000n),
        tokens("2026-11-01", "c", 100_000n), // $0.10 billed
      ],
      [
        {
          day: "2026-11-01",
          model: "a",
          micros: 980_000n,
          webSearchMicros: 0n,
        }, // -2%: within
        {
          day: "2026-11-01",
          model: "b",
          micros: 970_000n,
          webSearchMicros: 0n,
        }, // -3%: flagged
        { day: "2026-11-01", model: "c", micros: 95_000n, webSearchMicros: 0n }, // -5% but under a cent
      ],
      2,
    );
    expect(report.rows.map((r) => [r.model, r.diffMicros, r.flagged])).toEqual([
      ["a", -20_000n, false],
      ["b", -30_000n, true],
      ["c", -5_000n, false],
    ]);
  });

  it("flags usage only one side has, such as unreported requests", () => {
    const report = reconcile(
      [tokens("2026-11-01", "claude-opus-5-5", 2_000_000n)],
      [
        {
          day: "2026-11-02",
          model: "claude-opus-5-5",
          micros: 50_000n,
          webSearchMicros: 0n,
        },
      ],
    );
    expect(report.rows.map((r) => [r.day, r.diffMicros, r.flagged])).toEqual([
      ["2026-11-01", -2_000_000n, true],
      ["2026-11-02", 50_000n, true],
    ]);
  });

  it("compares web search in total, apart from token rows", () => {
    const search = (day: string, micros: bigint) => ({
      day,
      model: null,
      costType: "web_search",
      micros,
    });
    const report = reconcile(
      [search("2026-11-01", 500_000n), search("2026-11-02", 100_000n)],
      [
        {
          day: "2026-11-01",
          model: "claude-sonnet-5-5",
          micros: 0n,
          webSearchMicros: 400_000n,
        },
        {
          day: "2026-11-02",
          model: "claude-haiku-5-5",
          micros: 0n,
          webSearchMicros: 200_000n,
        },
      ],
    );
    expect(report.webSearch).toEqual({
      billedMicros: 600_000n,
      recordedMicros: 600_000n,
      diffMicros: 0n,
      flagged: false,
    });
    expect(report.otherCosts).toEqual([]);
    // Token totals don't include search.
    expect(report.totals.recordedMicros).toBe(0n);
  });

  it("flags web search the tracker missed", () => {
    const report = reconcile(
      [
        {
          day: "2026-11-01",
          model: null,
          costType: "web_search",
          micros: 100_000n,
        },
      ],
      [],
    );
    expect(report.webSearch).toEqual({
      billedMicros: 100_000n,
      recordedMicros: 0n,
      diffMicros: -100_000n,
      flagged: true,
    });
  });

  it("lists other non-token costs separately instead of as differences", () => {
    const report = reconcile(
      [
        {
          day: "2026-11-01",
          model: null,
          costType: "code_execution",
          micros: 1n,
        },
        {
          day: "2026-11-02",
          model: null,
          costType: "code_execution",
          micros: 2n,
        },
        { day: "2026-11-01", model: null, costType: "storage", micros: 5n },
      ],
      [],
    );
    expect(report.rows).toEqual([]);
    expect(report.otherCosts).toEqual([
      { costType: "code_execution", micros: 3n },
      { costType: "storage", micros: 5n },
    ]);
  });
});

describe("formatMicros", () => {
  it("is exact, with a sign for negatives", () => {
    expect(formatMicros(1_237_891n)).toBe("$1.237891");
    expect(formatMicros(-300n)).toBe("-$0.000300");
    expect(formatMicros(0n)).toBe("$0.000000");
  });
});

describe("fetchAnthropicCostReport", () => {
  const from = new Date("2026-10-01T00:00:00Z");
  const to = new Date("2026-11-01T00:00:00Z");
  const page = (day: string, cents: string, next: string | null) => ({
    data: [
      {
        starting_at: `${day}T00:00:00Z`,
        results: [
          { amount: cents, currency: "USD", cost_type: "tokens", model: "m" },
        ],
      },
    ],
    has_more: next !== null,
    next_page: next,
  });

  it("requests daily costs by description and follows pagination", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json(page("2026-10-01", "100", "p2")))
      .mockResolvedValueOnce(Response.json(page("2026-10-02", "200", null)));
    const costs = await fetchAnthropicCostReport({
      adminKey: "sk-ant-admin01-test",
      from,
      to,
      fetch,
    });
    expect(costs.map((c) => [c.day, c.micros])).toEqual([
      ["2026-10-01", 1_000_000n],
      ["2026-10-02", 2_000_000n],
    ]);

    const [firstUrl, init] = fetch.mock.calls[0] as [URL, RequestInit];
    expect(firstUrl.origin + firstUrl.pathname).toBe(
      "https://api.anthropic.com/v1/organizations/cost_report",
    );
    expect(firstUrl.searchParams.get("starting_at")).toBe(
      "2026-10-01T00:00:00.000Z",
    );
    expect(firstUrl.searchParams.get("ending_at")).toBe(
      "2026-11-01T00:00:00.000Z",
    );
    expect(firstUrl.searchParams.getAll("group_by[]")).toEqual(["description"]);
    expect(firstUrl.searchParams.get("page")).toBeNull();
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-ant-admin01-test");
    expect(headers["anthropic-version"]).toBeTruthy();
    expect((fetch.mock.calls[1] as [URL])[0].searchParams.get("page")).toBe(
      "p2",
    );
  });

  it("explains that an Admin API key is needed when one is rejected", async () => {
    const fetch = vi.fn().mockResolvedValue(
      Response.json(
        {
          error: {
            type: "authentication_error",
            message: "invalid x-api-key",
          },
        },
        { status: 401 },
      ),
    );
    const error = await fetchAnthropicCostReport({
      adminKey: "sk-ant-api03-regular",
      from,
      to,
      fetch,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CostReportError);
    expect(error).toMatchObject({ status: 401 });
    expect((error as Error).message).toMatch(/Admin API key/);
  });
});
