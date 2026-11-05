import { describe, expect, it, vi } from "vitest";
import type { AuthenticateResult } from "@/db/api-keys";
import type { BudgetCheckInputs } from "@/lib/budget-check";
import { createBudgetCheckHandler, MAX_BODY_BYTES } from "./handler";

const now = new Date("2026-11-05T12:00:00Z");
const projectId = "4f0c6c5e-2f7a-4b8e-9d1a-3c5e7f9a1b2c";
const apiKey = "act_" + "a".repeat(43);

const defaultInputs: BudgetCheckInputs = {
  monthlyBudgetUsd: "10.00",
  runBudgetUsd: "1.00",
  monthSpentUsd: "4.000000",
  runSpentUsd: "0.900000",
};

function setup({
  auth = {
    ok: true,
    projectId,
    apiKeyId: "key-1",
    scope: "ingest",
  } as AuthenticateResult,
  inputs = defaultInputs as BudgetCheckInputs | null,
} = {}) {
  // null stands for a project that no longer exists.
  const getInputs = vi.fn().mockResolvedValue(inputs ?? undefined);
  const recordAuthFailure = vi.fn().mockResolvedValue({
    limited: false,
    resetAt: new Date(now.getTime() + 60_000),
  });
  const handler = createBudgetCheckHandler({
    authenticate: vi.fn().mockResolvedValue(auth),
    recordAuthFailure,
    getInputs,
    now: () => now,
  });
  return { handler, getInputs, recordAuthFailure };
}

const post = (body?: unknown, key: string | null = apiKey) =>
  new Request("http://localhost/api/budget/check", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    },
    body:
      body === undefined
        ? undefined
        : typeof body === "string"
          ? body
          : JSON.stringify(body),
  });

describe("POST /api/budget/check", () => {
  it("answers for the key's project, run and estimate", async () => {
    const { handler, getInputs } = setup();
    const response = await handler(
      post({ estimatedCostUsd: "0.05", runId: "run_42" }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(getInputs).toHaveBeenCalledWith(projectId, "run_42", now);
    expect(await response.json()).toMatchObject({
      allowed: true,
      reasons: [],
      estimatedCostUsd: "0.050000",
      month: { period: "2026-11", remainingUsd: "6.000000" },
      run: { runId: "run_42", remainingUsd: "0.100000", allowed: true },
    });
  });

  it("returns a denial as a 200 with its reasons", async () => {
    const { handler } = setup();
    const response = await handler(
      post({ estimatedCostUsd: 0.2, runId: "run_42" }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      allowed: false,
      reasons: ["run_budget"],
    });
  });

  it.each([undefined, "", "  "])(
    "treats an empty body (%j) as a check of the month alone",
    async (body) => {
      const { handler, getInputs } = setup({
        inputs: { ...defaultInputs, runSpentUsd: null },
      });
      const response = await handler(post(body));
      expect(response.status).toBe(200);
      expect(getInputs).toHaveBeenCalledWith(projectId, undefined, now);
      expect((await response.json()).run).toBeNull();
    },
  );

  it("rejects invalid JSON and invalid fields", async () => {
    const { handler, getInputs } = setup();
    const invalidJson = await handler(post("{"));
    expect(invalidJson.status).toBe(400);
    expect((await invalidJson.json()).error.code).toBe("invalid_json");

    const invalid = await handler(post({ estimatedCostUsd: "-1", extra: 1 }));
    expect(invalid.status).toBe(400);
    const { error } = await invalid.json();
    expect(error.code).toBe("invalid_payload");
    expect(error.fieldErrors).toHaveProperty("estimatedCostUsd");
    expect(getInputs).not.toHaveBeenCalled();
  });

  it("rejects a body over the limit", async () => {
    const { handler } = setup();
    const response = await handler(
      post({ runId: "r", pad: "x".repeat(MAX_BODY_BYTES) }),
    );
    expect(response.status).toBe(413);
  });

  it("requires an ingest key", async () => {
    const missing = await setup().handler(post({}, null));
    expect(missing.status).toBe(401);

    const read = await setup({
      auth: { ok: true, projectId, apiKeyId: "k", scope: "read" },
    }).handler(post({}));
    expect(read.status).toBe(403);
    expect((await read.json()).error.code).toBe("insufficient_scope");
  });

  it("returns 404 when the key's project no longer exists", async () => {
    const response = await setup({ inputs: null }).handler(post({}));
    expect(response.status).toBe(404);
  });
});
