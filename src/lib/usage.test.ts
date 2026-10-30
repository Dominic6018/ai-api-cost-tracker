import { describe, expect, it } from "vitest";
import { MAX_METADATA_BYTES, parseUsagePayload } from "./usage";

const now = new Date("2026-11-01T12:00:00Z");

const valid = {
  provider: "anthropic",
  model: "claude-sonnet-5-5",
  inputTokens: 1200,
  outputTokens: 300,
};

function fieldErrors(body: unknown) {
  const result = parseUsagePayload(body, now);
  if (result.ok) throw new Error("expected validation to fail");
  return result.fieldErrors;
}

describe("parseUsagePayload", () => {
  it("accepts a minimal payload, defaulting cached tokens and occurredAt", () => {
    const result = parseUsagePayload(valid, now);
    expect(result).toEqual({
      ok: true,
      usage: {
        ...valid,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        occurredAt: now,
      },
    });
  });

  it("accepts every optional field", () => {
    const result = parseUsagePayload(
      {
        ...valid,
        cachedInputTokens: 1000,
        requestId: "req_123",
        occurredAt: "2026-11-01T10:00:00+01:00",
        metadata: { route: "/chat", userTier: "pro" },
      },
      now,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.usage.occurredAt.toISOString()).toBe(
      "2026-11-01T09:00:00.000Z",
    );
    expect(result.usage.requestId).toBe("req_123");
    expect(result.usage.metadata).toEqual({ route: "/chat", userTier: "pro" });
  });

  it("trims the model name", () => {
    const result = parseUsagePayload({ ...valid, model: "  gpt-4.1  " }, now);
    expect(result.ok && result.usage.model).toBe("gpt-4.1");
  });

  it.each([
    ["provider", { provider: "acme" }],
    ["model", { model: "   " }],
    ["inputTokens", { inputTokens: -1 }],
    ["outputTokens", { outputTokens: 1.5 }],
    ["inputTokens", { inputTokens: "100" }],
    ["occurredAt", { occurredAt: "yesterday" }],
    ["occurredAt", { occurredAt: "2026-11-01T10:00:00" }],
    ["requestId", { requestId: "" }],
    ["metadata", { metadata: ["not", "an", "object"] }],
  ])("rejects an invalid %s", (field, override) => {
    expect(fieldErrors({ ...valid, ...override })).toHaveProperty(field);
  });

  it.each(["provider", "model", "inputTokens", "outputTokens"])(
    "requires %s",
    (field) => {
      const body: Record<string, unknown> = { ...valid };
      delete body[field];
      expect(fieldErrors(body)).toHaveProperty(field);
    },
  );

  it("rejects cached tokens above input tokens", () => {
    expect(
      fieldErrors({ ...valid, inputTokens: 10, cachedInputTokens: 11 }),
    ).toHaveProperty("cachedInputTokens");
  });

  it("rejects unknown fields", () => {
    const result = parseUsagePayload({ ...valid, costUsd: "0" }, now);
    expect(result.ok).toBe(false);
  });

  it("rejects metadata over the size limit", () => {
    const metadata = { blob: "x".repeat(MAX_METADATA_BYTES) };
    expect(fieldErrors({ ...valid, metadata })).toHaveProperty("metadata");
  });

  it("allows small clock skew but rejects future occurredAt", () => {
    const soon = new Date(now.getTime() + 60_000).toISOString();
    const later = new Date(now.getTime() + 60 * 60_000).toISOString();
    expect(parseUsagePayload({ ...valid, occurredAt: soon }, now).ok).toBe(
      true,
    );
    expect(fieldErrors({ ...valid, occurredAt: later })).toHaveProperty(
      "occurredAt",
    );
  });

  it("rejects a non-object body", () => {
    expect(parseUsagePayload(null, now).ok).toBe(false);
    expect(parseUsagePayload([valid], now).ok).toBe(false);
  });

  it("accepts cache-write tokens within input tokens", () => {
    const result = parseUsagePayload(
      { ...valid, cachedInputTokens: 600, cacheWriteInputTokens: 600 },
      now,
    );
    expect(result.ok && result.usage.cacheWriteInputTokens).toBe(600);
  });

  it("rejects cached plus cache-write tokens above input tokens", () => {
    expect(
      fieldErrors({
        ...valid,
        cachedInputTokens: 600,
        cacheWriteInputTokens: 601,
      }),
    ).toHaveProperty("cacheWriteInputTokens");
  });

  it("rejects negative cache-write tokens", () => {
    expect(fieldErrors({ ...valid, cacheWriteInputTokens: -1 })).toHaveProperty(
      "cacheWriteInputTokens",
    );
  });
});
