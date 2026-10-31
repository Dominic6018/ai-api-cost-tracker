import { describe, expect, it } from "vitest";
import {
  clientIp,
  RATE_LIMITS,
  rateLimitKey,
  retryAfterSeconds,
} from "./rate-limit";

describe("rateLimitKey", () => {
  it("hashes the value, so emails and IPs aren't stored", () => {
    const key = rateLimitKey(RATE_LIMITS.signInEmail, "ada@example.com");
    expect(key).toMatch(/^sign-in:email:[0-9a-f]{64}$/);
    expect(key).not.toContain("ada");
  });

  it("is stable per value and separate per rule", () => {
    const a = rateLimitKey(RATE_LIMITS.signInIp, "203.0.113.7");
    expect(rateLimitKey(RATE_LIMITS.signInIp, "203.0.113.7")).toBe(a);
    expect(rateLimitKey(RATE_LIMITS.signInIp, "203.0.113.8")).not.toBe(a);
    expect(rateLimitKey(RATE_LIMITS.apiKeyIp, "203.0.113.7")).not.toBe(a);
  });
});

describe("clientIp", () => {
  const ip = (headers: Record<string, string>) =>
    clientIp(new Headers(headers));

  it("uses the last X-Forwarded-For entry, the one the nearest proxy added", () => {
    expect(ip({ "x-forwarded-for": "203.0.113.7" })).toBe("203.0.113.7");
    // A client can send its own header; the proxy appends the real address.
    expect(ip({ "x-forwarded-for": "10.0.0.1, 203.0.113.7" })).toBe(
      "203.0.113.7",
    );
    expect(ip({ "x-forwarded-for": "203.0.113.7, " })).toBe("203.0.113.7");
  });

  it("falls back to X-Real-IP, then to a shared bucket", () => {
    expect(ip({ "x-real-ip": "198.51.100.2" })).toBe("198.51.100.2");
    expect(ip({ "x-forwarded-for": " , " })).toBe("unknown");
    expect(ip({})).toBe("unknown");
  });
});

describe("retryAfterSeconds", () => {
  const now = new Date("2026-11-01T12:00:00Z");

  it("rounds up to whole seconds", () => {
    expect(retryAfterSeconds(new Date(now.getTime() + 90_500), now)).toBe(91);
    expect(retryAfterSeconds(new Date(now.getTime() + 60_000), now)).toBe(60);
  });

  it("is never less than one second", () => {
    expect(retryAfterSeconds(now, now)).toBe(1);
    expect(retryAfterSeconds(new Date(now.getTime() - 5_000), now)).toBe(1);
  });
});
