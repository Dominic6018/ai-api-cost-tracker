import { describe, expect, it, vi } from "vitest";
import type { AuthenticateResult } from "@/db/api-keys";
import type { UsageEvent } from "@/db/schema";
import type { RecordUsageResult } from "@/db/usage";
import { createUsageHandler, MAX_BODY_BYTES } from "./handler";

const now = new Date("2026-11-01T12:00:00Z");
const projectId = "4f0c6c5e-2f7a-4b8e-9d1a-3c5e7f9a1b2c";
const apiKey = "act_" + "a".repeat(43);

const body = {
  provider: "openai",
  model: "gpt-4.1",
  inputTokens: 1000,
  outputTokens: 500,
  requestId: "req_1",
};

const storedEvent: UsageEvent = {
  id: "0d7e3c1a-5b2f-4e6d-8a9c-1b3d5f7e9a0c",
  projectId,
  provider: "openai",
  model: "gpt-4.1",
  inputTokens: 1000,
  outputTokens: 500,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  costUsd: "0.006000",
  requestId: "req_1",
  occurredAt: now,
  metadata: null,
  createdAt: now,
};

function setup({
  result = {
    ok: true,
    event: storedEvent,
    replayed: false,
  } as RecordUsageResult,
  auth = {
    ok: true,
    projectId,
    apiKeyId: "key-1",
  } as AuthenticateResult,
} = {}) {
  const authenticate = vi.fn().mockResolvedValue(auth);
  const recordUsage = vi.fn().mockResolvedValue(result);
  const handler = createUsageHandler({
    authenticate,
    recordUsage,
    now: () => now,
  });
  return { handler, authenticate, recordUsage };
}

function post(
  payload: unknown,
  authorization: string | null = `Bearer ${apiKey}`,
) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (authorization !== null) headers.authorization = authorization;
  return new Request("http://localhost/api/usage", {
    method: "POST",
    headers,
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  });
}

describe("POST /api/usage handler", () => {
  it("records usage for the key's project and returns 201", async () => {
    const { handler, authenticate, recordUsage } = setup();
    const response = await handler(post(body));

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      event: {
        id: storedEvent.id,
        projectId,
        provider: "openai",
        model: "gpt-4.1",
        inputTokens: 1000,
        outputTokens: 500,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        costUsd: "0.006000",
        requestId: "req_1",
        occurredAt: "2026-11-01T12:00:00.000Z",
      },
      replayed: false,
    });
    expect(authenticate).toHaveBeenCalledWith(apiKey);
    expect(recordUsage).toHaveBeenCalledWith({
      ...body,
      projectId,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      occurredAt: now,
    });
  });

  it.each([
    ["no Authorization header", null],
    ["an empty header", ""],
    ["a non-Bearer scheme", `Basic ${apiKey}`],
    ["a Bearer header without a key", "Bearer "],
  ])("returns 401 for %s without checking the key", async (_, header) => {
    const { handler, authenticate, recordUsage } = setup();
    const response = await handler(post(body, header));

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toMatch(/^Bearer/);
    expect((await response.json()).error.code).toBe("unauthorized");
    expect(authenticate).not.toHaveBeenCalled();
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it("returns 401 when the key is rejected", async () => {
    const { handler, recordUsage } = setup({ auth: { ok: false } });
    const response = await handler(post(body));
    expect(response.status).toBe(401);
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it("checks the key before reading the body", async () => {
    const { handler } = setup({ auth: { ok: false } });
    const response = await handler(post("{not json"));
    expect(response.status).toBe(401);
  });

  it("rejects a projectId in the body; the key decides the project", async () => {
    const { handler, recordUsage } = setup();
    const response = await handler(post({ ...body, projectId }));
    expect(response.status).toBe(400);
    expect(recordUsage).not.toHaveBeenCalled();
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
    ["request_id_conflict", 409],
  ] as const)("maps %s to HTTP %d", async (error, status) => {
    const { handler } = setup({ result: { ok: false, error } });
    const response = await handler(post(body));
    expect(response.status).toBe(status);
    expect((await response.json()).error.code).toBe(error);
  });

  it("returns 200 with the stored event when a retry is replayed", async () => {
    const { handler } = setup({
      result: { ok: true, event: storedEvent, replayed: true },
    });
    const response = await handler(post(body));

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.replayed).toBe(true);
    expect(json.event.id).toBe(storedEvent.id);
  });
});
