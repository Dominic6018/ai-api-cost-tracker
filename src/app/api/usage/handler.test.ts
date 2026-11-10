import { describe, expect, it, vi } from "vitest";
import type { AuthenticateResult } from "@/db/api-keys";
import type { RateLimitResult } from "@/db/rate-limits";
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
  cacheWrite1hInputTokens: 0,
  serviceTier: "standard",
  webSearchRequests: 0,
  webSearchCostUsd: "0.000000",
  audioInputTokens: 0,
  cachedAudioInputTokens: 0,
  audioOutputTokens: 0,
  imageInputTokens: 0,
  cachedImageInputTokens: 0,
  imageOutputTokens: 0,
  costUsd: "0.006000",
  pricingStatus: "priced",
  unpricedReason: null,
  requestId: "req_1",
  occurredAt: now,
  metadata: null,
  customerId: null,
  userId: null,
  feature: null,
  runId: null,
  tags: null,
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
    scope: "ingest",
  } as AuthenticateResult,
  limit = {
    limited: false,
    resetAt: new Date(now.getTime() + 15 * 60 * 1000),
  } as RateLimitResult,
} = {}) {
  const authenticate = vi.fn().mockResolvedValue(auth);
  const recordAuthFailure = vi.fn().mockResolvedValue(limit);
  const recordUsage = vi.fn().mockResolvedValue(result);
  const countInvalid = vi.fn().mockResolvedValue(undefined);
  const handler = createUsageHandler({
    authenticate,
    recordAuthFailure,
    recordUsage,
    countInvalid,
    now: () => now,
  });
  return {
    handler,
    authenticate,
    recordAuthFailure,
    recordUsage,
    countInvalid,
  };
}

function post(
  payload: unknown,
  authorization: string | null = `Bearer ${apiKey}`,
  extraHeaders: Record<string, string> = {},
) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...extraHeaders,
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
    const { handler, authenticate, recordAuthFailure, recordUsage } = setup();
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
        cacheWrite1hInputTokens: 0,
        serviceTier: "standard",
        webSearchRequests: 0,
        webSearchCostUsd: "0.000000",
        audioInputTokens: 0,
        cachedAudioInputTokens: 0,
        audioOutputTokens: 0,
        imageInputTokens: 0,
        cachedImageInputTokens: 0,
        imageOutputTokens: 0,
        costUsd: "0.006000",
        pricingStatus: "priced",
        unpricedReason: null,
        requestId: "req_1",
        customerId: null,
        userId: null,
        feature: null,
        runId: null,
        tags: null,
        occurredAt: "2026-11-01T12:00:00.000Z",
      },
      replayed: false,
    });
    expect(authenticate).toHaveBeenCalledWith(apiKey);
    expect(recordAuthFailure).not.toHaveBeenCalled();
    expect(recordUsage).toHaveBeenCalledWith({
      ...body,
      projectId,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      cacheWrite1hInputTokens: 0,
      serviceTier: "standard",
      webSearchRequests: 0,
      audioInputTokens: 0,
      cachedAudioInputTokens: 0,
      audioOutputTokens: 0,
      imageInputTokens: 0,
      cachedImageInputTokens: 0,
      imageOutputTokens: 0,
      occurredAt: now,
    });
  });

  it.each([
    ["no Authorization header", null],
    ["an empty header", ""],
    ["a non-Bearer scheme", `Basic ${apiKey}`],
    ["a Bearer header without a key", "Bearer "],
  ])("returns 401 for %s without checking the key", async (_, header) => {
    const { handler, authenticate, recordAuthFailure, recordUsage } = setup();
    const response = await handler(post(body, header));

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toMatch(/^Bearer/);
    expect((await response.json()).error.code).toBe("unauthorized");
    expect(authenticate).not.toHaveBeenCalled();
    expect(recordAuthFailure).not.toHaveBeenCalled();
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it("refuses a read key with 403: report keys can't send usage", async () => {
    const { handler, recordAuthFailure, recordUsage } = setup({
      auth: { ok: true, projectId, apiKeyId: "key-2", scope: "read" },
    });
    const response = await handler(post(body));
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("insufficient_scope");
    expect(recordUsage).not.toHaveBeenCalled();
    expect(recordAuthFailure).not.toHaveBeenCalled();
  });

  it("returns 401 when the key is rejected, and counts it against the client IP", async () => {
    const { handler, recordAuthFailure, recordUsage } = setup({
      auth: { ok: false },
    });
    const response = await handler(
      post(body, undefined, { "x-forwarded-for": "203.0.113.7" }),
    );
    expect(response.status).toBe(401);
    expect(recordAuthFailure).toHaveBeenCalledWith("203.0.113.7");
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it("returns 429 with Retry-After once the client IP is over its limit", async () => {
    const { handler, recordUsage } = setup({
      auth: { ok: false },
      limit: {
        limited: true,
        resetAt: new Date(now.getTime() + 90_500),
      },
    });
    const response = await handler(post(body));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("91");
    const json = await response.json();
    expect(json.error.code).toBe("rate_limited");
    expect(json.error.message).toMatch(/91 seconds/);
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it("checks the key before reading the body", async () => {
    const { handler } = setup({ auth: { ok: false } });
    const response = await handler(post("{not json"));
    expect(response.status).toBe(401);
  });

  it("passes customer, user, feature and run through, trimmed", async () => {
    const { handler, recordUsage } = setup({
      result: {
        ok: true,
        event: {
          ...storedEvent,
          customerId: "cus_42",
          userId: "u_7",
          feature: "support-chat",
          runId: "run_9",
        },
        replayed: false,
      },
    });
    const response = await handler(
      post({
        ...body,
        customerId: " cus_42 ",
        userId: "u_7",
        feature: "support-chat",
        runId: "run_9",
      }),
    );
    expect(response.status).toBe(201);
    expect(recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: "cus_42",
        userId: "u_7",
        feature: "support-chat",
        runId: "run_9",
      }),
    );
    expect((await response.json()).event).toMatchObject({
      customerId: "cus_42",
      feature: "support-chat",
    });
  });

  it("passes tags through and returns them", async () => {
    const { handler, recordUsage } = setup({
      result: {
        ok: true,
        event: { ...storedEvent, tags: { env: "prod", team: "search" } },
        replayed: false,
      },
    });
    const response = await handler(
      post({ ...body, tags: { env: "prod", team: " search " } }),
    );
    expect(response.status).toBe(201);
    expect(recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ tags: { env: "prod", team: "search" } }),
    );
    expect((await response.json()).event.tags).toEqual({
      env: "prod",
      team: "search",
    });
  });

  it.each([
    ["an empty customerId", { customerId: "  " }],
    ["a tag named like attribution", { tags: { feature: "x" } }],
    ["a tag with a colon in its key", { tags: { "a:b": "x" } }],
    ["a tag with a number value", { tags: { env: 1 } }],
    ["a feature over 200 characters", { feature: "f".repeat(201) }],
    ["a non-string runId", { runId: 42 }],
  ])("returns 400 for %s", async (_, extra) => {
    const { handler, recordUsage } = setup();
    const response = await handler(post({ ...body, ...extra }));
    expect(response.status).toBe(400);
    expect(recordUsage).not.toHaveBeenCalled();
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

  it("counts an invalid body for the key's project", async () => {
    const { handler, recordUsage, countInvalid } = setup();
    const response = await handler(post({ provider: "openai" }));
    expect(response.status).toBe(400);
    expect(countInvalid).toHaveBeenCalledWith(projectId, 1);
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it("returns 413 for an oversized body", async () => {
    const { handler, recordUsage } = setup();
    const response = await handler(post("x".repeat(MAX_BODY_BYTES + 1)));
    expect(response.status).toBe(413);
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it.each([
    ["project_not_found", 404],
    ["request_id_conflict", 409],
  ] as const)("maps %s to HTTP %d", async (error, status) => {
    const { handler } = setup({ result: { ok: false, error } });
    const response = await handler(post(body));
    expect(response.status).toBe(status);
    expect((await response.json()).error.code).toBe(error);
  });

  it("returns 201 for usage stored without a price, saying which is missing", async () => {
    const { handler } = setup({
      result: {
        ok: true,
        event: {
          ...storedEvent,
          costUsd: null,
          pricingStatus: "unpriced",
          unpricedReason: "no_pricing",
        },
        replayed: false,
      },
    });
    const response = await handler(post(body));
    expect(response.status).toBe(201);
    expect((await response.json()).event).toMatchObject({
      costUsd: null,
      pricingStatus: "unpriced",
      unpricedReason: "no_pricing",
    });
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
