import { describe, expect, it, vi } from "vitest";
import type { AuthenticateResult } from "@/db/api-keys";
import type { RecordOutcomeResult } from "@/db/outcomes";
import type { Outcome } from "@/db/schema";
import { createOutcomesHandler, MAX_BODY_BYTES } from "./handler";

const now = new Date("2026-11-04T12:00:00Z");
const projectId = "4f0c6c5e-2f7a-4b8e-9d1a-3c5e7f9a1b2c";
const apiKey = "act_" + "a".repeat(43);

const stored: Outcome = {
  id: "0d7e3c1a-5b2f-4e6d-8a9c-1b3d5f7e9a0c",
  projectId,
  name: "ticket_resolved",
  count: 1,
  occurredAt: now,
  outcomeId: "ticket-881",
  customerId: "cus_42",
  userId: null,
  feature: "support-chat",
  runId: null,
  createdAt: now,
};

function setup({
  auth = {
    ok: true,
    projectId,
    apiKeyId: "key-1",
    scope: "ingest",
  } as AuthenticateResult,
  result = {
    ok: true,
    outcome: stored,
    replayed: false,
  } as RecordOutcomeResult,
} = {}) {
  const recordOutcome = vi.fn().mockResolvedValue(result);
  const recordAuthFailure = vi.fn().mockResolvedValue({
    limited: false,
    resetAt: new Date(now.getTime() + 60_000),
  });
  const handler = createOutcomesHandler({
    authenticate: vi.fn().mockResolvedValue(auth),
    recordAuthFailure,
    recordOutcome,
    now: () => now,
  });
  return { handler, recordOutcome, recordAuthFailure };
}

const post = (body: unknown, key: string | null = apiKey) =>
  new Request("http://localhost/api/outcomes", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("POST /api/outcomes", () => {
  it("records an outcome for the key's project and returns 201", async () => {
    const { handler, recordOutcome } = setup();
    const response = await handler(
      post({
        name: "ticket_resolved",
        outcomeId: "ticket-881",
        customerId: " cus_42 ",
        feature: "support-chat",
      }),
    );
    expect(response.status).toBe(201);
    expect(recordOutcome).toHaveBeenCalledWith({
      projectId,
      name: "ticket_resolved",
      count: 1,
      outcomeId: "ticket-881",
      customerId: "cus_42",
      feature: "support-chat",
      occurredAt: now,
    });
    expect((await response.json()).outcome).toMatchObject({
      name: "ticket_resolved",
      count: 1,
      customerId: "cus_42",
      occurredAt: "2026-11-04T12:00:00.000Z",
    });
  });

  it("returns 200 with the stored outcome for a retry", async () => {
    const { handler } = setup({
      result: { ok: true, outcome: stored, replayed: true },
    });
    const response = await handler(
      post({ name: "ticket_resolved", outcomeId: "ticket-881" }),
    );
    expect(response.status).toBe(200);
    expect((await response.json()).replayed).toBe(true);
  });

  it("returns 409 when an outcomeId is reused for something else", async () => {
    const { handler } = setup({
      result: { ok: false, error: "outcome_id_conflict" },
    });
    const response = await handler(
      post({ name: "order_completed", outcomeId: "ticket-881" }),
    );
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("outcome_id_conflict");
  });

  it.each([
    ["no name", { count: 2 }],
    ["an uppercase name", { name: "TicketResolved" }],
    ["a name with spaces", { name: "ticket resolved" }],
    ["a zero count", { name: "a", count: 0 }],
    ["a fractional count", { name: "a", count: 1.5 }],
    ["a count over the limit", { name: "a", count: 1_000_001 }],
    ["an empty customerId", { name: "a", customerId: " " }],
    ["a projectId", { name: "a", projectId }],
    ["a future occurredAt", { name: "a", occurredAt: "2026-11-04T13:00:00Z" }],
  ])("returns 400 for %s", async (_, body) => {
    const { handler, recordOutcome } = setup();
    const response = await handler(post(body));
    expect(response.status).toBe(400);
    expect(recordOutcome).not.toHaveBeenCalled();
  });

  it("accepts dotted and dashed names and a batch count", async () => {
    const { handler, recordOutcome } = setup();
    const response = await handler(
      post({ name: "order.completed-v2", count: 250 }),
    );
    expect(response.status).toBe(201);
    expect(recordOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ name: "order.completed-v2", count: 250 }),
    );
  });

  it("requires an API key and counts rejected ones", async () => {
    const missing = setup();
    expect((await missing.handler(post({ name: "a" }, null))).status).toBe(401);
    expect(missing.recordAuthFailure).not.toHaveBeenCalled();

    const bad = setup({ auth: { ok: false } });
    expect((await bad.handler(post({ name: "a" }))).status).toBe(401);
    expect(bad.recordAuthFailure).toHaveBeenCalled();
    expect(bad.recordOutcome).not.toHaveBeenCalled();
  });

  it("returns 400 for malformed JSON and 413 for an oversized body", async () => {
    const { handler } = setup();
    expect((await handler(post("{not json"))).status).toBe(400);
    expect((await handler(post("x".repeat(MAX_BODY_BYTES + 1)))).status).toBe(
      413,
    );
  });
});
