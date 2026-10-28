import { describe, expect, it, vi } from "vitest";
import type { UsageEvent } from "@/db/schema";
import type { RecordUsageResult } from "@/db/usage";
import { createUsageHandler, MAX_BODY_BYTES } from "./handler";

const now = new Date("2026-11-01T12:00:00Z");

const body = {
  projectId: "4f0c6c5e-2f7a-4b8e-9d1a-3c5e7f9a1b2c",
  provider: "openai",
  model: "gpt-4.1",
  inputTokens: 1000,
  outputTokens: 500,
  requestId: "req_1",
};

const storedEvent: UsageEvent = {
  id: "0d7e3c1a-5b2f-4e6d-8a9c-1b3d5f7e9a0c",
  projectId: body.projectId,
  provider: "openai",
  model: "gpt-4.1",
  inputTokens: 1000,
  outputTokens: 500,
  cachedInputTokens: 0,
  costUsd: "0.006000",
  requestId: "req_1",
  occurredAt: now,
  metadata: null,
  createdAt: now,
};

function setup(result: RecordUsageResult = { ok: true, event: storedEvent }) {
  const recordUsage = vi.fn().mockResolvedValue(result);
  const handler = createUsageHandler({
    recordUsage,
    enabled: true,
    now: () => now,
  });
  return { handler, recordUsage };
}

function post(payload: unknown) {
  return new Request("http://localhost/api/usage", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  });
}

describe("POST /api/usage handler", () => {
  it("records valid usage and returns 201 with the event", async () => {
    const { handler, recordUsage } = setup();
    const response = await handler(post(body));

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      event: {
        id: storedEvent.id,
        projectId: body.projectId,
        provider: "openai",
        model: "gpt-4.1",
        inputTokens: 1000,
        outputTokens: 500,
        cachedInputTokens: 0,
        costUsd: "0.006000",
        requestId: "req_1",
        occurredAt: "2026-11-01T12:00:00.000Z",
      },
    });
    expect(recordUsage).toHaveBeenCalledWith({
      ...body,
      cachedInputTokens: 0,
      occurredAt: now,
    });
  });

  it("returns 400 with field errors for an invalid payload", async () => {
    const { handler, recordUsage } = setup();
    const response = await handler(post({ ...body, inputTokens: -5 }));

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.error.code).toBe("invalid_payload");
    expect(json.error.fieldErrors).toHaveProperty("inputTokens");
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it("returns 400 for malformed JSON", async () => {
    const { handler } = setup();
    const response = await handler(post("{not json"));
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("invalid_json");
  });

  it("returns 413 for an oversized body", async () => {
    const { handler, recordUsage } = setup();
    const response = await handler(post("x".repeat(MAX_BODY_BYTES + 1)));
    expect(response.status).toBe(413);
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it.each([
    ["no_pricing", 422],
    ["project_not_found", 404],
    ["duplicate_request", 409],
  ] as const)("maps %s to HTTP %d", async (error, status) => {
    const { handler } = setup({ ok: false, error });
    const response = await handler(post(body));
    expect(response.status).toBe(status);
    expect((await response.json()).error.code).toBe(error);
  });

  it("returns 404 without reading the body when disabled", async () => {
    const recordUsage = vi.fn();
    const handler = createUsageHandler({ recordUsage, enabled: false });
    const response = await handler(post(body));
    expect(response.status).toBe(404);
    expect(recordUsage).not.toHaveBeenCalled();
  });
});
