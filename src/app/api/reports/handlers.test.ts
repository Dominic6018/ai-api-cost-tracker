import { describe, expect, it, vi } from "vitest";
import type { AuthenticateResult } from "@/db/api-keys";
import type { SpendReport } from "@/db/reports";
import type { UsageEventsPage } from "@/db/usage-events";
import { encodeCursor } from "@/lib/usage-filters";
import { createSpendReportHandler, createUsageReportHandler } from "./handlers";

const now = new Date("2026-11-04T12:00:00Z");
const projectId = "4f0c6c5e-2f7a-4b8e-9d1a-3c5e7f9a1b2c";
const apiKey = "act_" + "a".repeat(43);

const totals = {
  costUsd: "1.500000",
  requests: 3,
  inputTokens: "3000",
  cachedInputTokens: "0",
  cacheWriteInputTokens: "0",
  cacheWrite1hInputTokens: "0",
  outputTokens: "300",
};
const report: SpendReport = {
  totals,
  groups: [{ key: "2026-11-04", ...totals }],
  truncated: false,
};
const page: UsageEventsPage = {
  rows: [
    {
      id: "0d7e3c1a-5b2f-4e6d-8a9c-1b3d5f7e9a0c",
      occurredAt: new Date("2026-11-04T10:00:00Z"),
      projectId,
      projectName: "Support Bot",
      provider: "openai",
      model: "gpt-4.1",
      inputTokens: 1000,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      cacheWrite1hInputTokens: 0,
      outputTokens: 100,
      costUsd: "0.002800",
      requestId: "req_1",
      customerId: "cus_42",
      userId: null,
      feature: null,
      runId: null,
      tags: { env: "prod" },
    },
  ],
  next: {
    occurredAt: "2026-11-04T10:00:00.000000Z",
    id: "0d7e3c1a-5b2f-4e6d-8a9c-1b3d5f7e9a0c",
  },
};

function setup(
  scope: "ingest" | "read" = "read",
  auth: AuthenticateResult = { ok: true, projectId, apiKeyId: "key-1", scope },
) {
  const deps = {
    authenticate: vi.fn().mockResolvedValue(auth),
    recordAuthFailure: vi.fn().mockResolvedValue({
      limited: false,
      resetAt: new Date(now.getTime() + 60_000),
    }),
    getSpendReport: vi.fn().mockResolvedValue(report),
    listUsageEvents: vi.fn().mockResolvedValue(page),
    now: () => now,
  };
  return {
    deps,
    spend: createSpendReportHandler(deps),
    usage: createUsageReportHandler(deps),
  };
}

const get = (path: string, key: string | null = apiKey) =>
  new Request(`http://localhost${path}`, {
    headers: key ? { authorization: `Bearer ${key}` } : {},
  });

describe("GET /api/reports/spend", () => {
  it("returns the key's project's spend for the parsed range", async () => {
    const { spend, deps } = setup();
    const response = await spend(
      get("/api/reports/spend?from=2026-11-01&to=2026-11-04&groupBy=model"),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      projectId,
      from: "2026-11-01",
      to: "2026-11-04",
      groupBy: "model",
      currency: "USD",
      ...report,
    });
    expect(deps.getSpendReport).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId,
        groupBy: "model",
        start: new Date("2026-11-01T00:00:00Z"),
        end: new Date("2026-11-05T00:00:00Z"),
      }),
    );
  });

  it("returns 400 with field errors for an invalid query", async () => {
    const { spend, deps } = setup();
    const response = await spend(get("/api/reports/spend?groupBy=week"));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe("invalid_query");
    expect(body.error.fieldErrors.groupBy).toBeDefined();
    expect(deps.getSpendReport).not.toHaveBeenCalled();
  });

  it("refuses an ingest key with 403, without counting it as a bad key", async () => {
    const { spend, deps } = setup("ingest");
    const response = await spend(get("/api/reports/spend"));
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("insufficient_scope");
    expect(deps.recordAuthFailure).not.toHaveBeenCalled();
    expect(deps.getSpendReport).not.toHaveBeenCalled();
  });

  it("requires a key", async () => {
    const { spend } = setup();
    expect((await spend(get("/api/reports/spend", null))).status).toBe(401);
  });
});

describe("GET /api/reports/usage", () => {
  it("lists the key's project's events, ignoring a project parameter", async () => {
    const { usage, deps } = setup();
    const response = await usage(
      get(
        "/api/reports/usage?project=00000000-0000-4000-8000-000000000000&customer=cus_42&limit=50",
      ),
    );
    expect(response.status).toBe(200);
    expect(deps.listUsageEvents).toHaveBeenCalledWith(
      { projectId, customerId: "cus_42" },
      50,
    );
    const body = await response.json();
    expect(body.events[0]).toEqual({
      id: page.rows[0].id,
      occurredAt: "2026-11-04T10:00:00.000Z",
      provider: "openai",
      model: "gpt-4.1",
      inputTokens: 1000,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      cacheWrite1hInputTokens: 0,
      outputTokens: 100,
      costUsd: "0.002800",
      requestId: "req_1",
      customerId: "cus_42",
      userId: null,
      feature: null,
      runId: null,
      tags: { env: "prod" },
    });
    expect(body.nextCursor).toBe(encodeCursor(page.next!));
    // The project name stays out of an API meant for other tools.
    expect(body.events[0]).not.toHaveProperty("projectName");
  });

  it("passes a cursor through and rejects one it didn't issue", async () => {
    const { usage, deps } = setup();
    const cursor = encodeCursor(page.next!);
    await usage(get(`/api/reports/usage?cursor=${cursor}`));
    expect(deps.listUsageEvents).toHaveBeenCalledWith(
      { projectId, cursor: page.next },
      100,
    );
    const bad = await usage(get("/api/reports/usage?cursor=not-a-cursor"));
    expect(bad.status).toBe(400);
  });

  it.each(["0", "501", "x"])("rejects limit=%s", async (limit) => {
    const { usage } = setup();
    expect((await usage(get(`/api/reports/usage?limit=${limit}`))).status).toBe(
      400,
    );
  });

  it("returns a null cursor on the last page", async () => {
    const { usage, deps } = setup();
    deps.listUsageEvents.mockResolvedValue({ rows: [], next: undefined });
    expect(
      (await (await usage(get("/api/reports/usage"))).json()).nextCursor,
    ).toBeNull();
  });

  it("refuses an ingest key with 403", async () => {
    const { usage } = setup("ingest");
    expect((await usage(get("/api/reports/usage"))).status).toBe(403);
  });
});
