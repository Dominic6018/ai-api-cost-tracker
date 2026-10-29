import { describe, expect, it } from "vitest";
import {
  API_KEY_PREFIX_LENGTH,
  apiKeyMatchesHash,
  apiKeyPrefix,
  generateApiKey,
  hashApiKey,
  isWellFormedApiKey,
  parseBearerToken,
} from "./api-keys";

describe("generateApiKey", () => {
  it("creates a well-formed act_ key with a matching prefix and hash", () => {
    const { key, prefix, hash } = generateApiKey();
    expect(key).toMatch(/^act_[A-Za-z0-9_-]{43}$/);
    expect(isWellFormedApiKey(key)).toBe(true);
    expect(prefix).toBe(key.slice(0, API_KEY_PREFIX_LENGTH));
    expect(hash).toBe(hashApiKey(key));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does not repeat keys or prefixes", () => {
    const keys = Array.from({ length: 200 }, generateApiKey);
    expect(new Set(keys.map((k) => k.key)).size).toBe(200);
    expect(new Set(keys.map((k) => k.prefix)).size).toBe(200);
  });

  it("never includes the secret part in the hash", () => {
    const { key, hash } = generateApiKey();
    expect(hash).not.toContain(key.slice(API_KEY_PREFIX_LENGTH));
  });
});

describe("isWellFormedApiKey", () => {
  it.each([
    "",
    "act_",
    "act_short",
    "xyz_" + "a".repeat(43),
    "act_" + "a".repeat(42),
    "act_" + "a".repeat(44),
    "act_" + "a".repeat(42) + "!",
  ])("rejects %j", (key) => {
    expect(isWellFormedApiKey(key)).toBe(false);
  });
});

describe("apiKeyMatchesHash", () => {
  const { key, hash } = generateApiKey();

  it("accepts the key that produced the hash", () => {
    expect(apiKeyMatchesHash(key, hash)).toBe(true);
  });

  it("rejects a different key with the same prefix", () => {
    const other = apiKeyPrefix(key) + "b".repeat(35);
    expect(apiKeyMatchesHash(other, hash)).toBe(false);
  });

  it("rejects a malformed stored hash instead of throwing", () => {
    expect(apiKeyMatchesHash(key, "abc")).toBe(false);
    expect(apiKeyMatchesHash(key, "")).toBe(false);
  });
});

describe("parseBearerToken", () => {
  it.each([
    ["Bearer act_abc", "act_abc"],
    ["bearer act_abc", "act_abc"],
    ["Bearer   act_abc  ", "act_abc"],
  ])("extracts the key from %j", (header, expected) => {
    expect(parseBearerToken(header)).toBe(expected);
  });

  it.each([null, "", "Bearer", "Bearer ", "Basic act_abc", "Bearer a b"])(
    "returns null for %j",
    (header) => {
      expect(parseBearerToken(header)).toBeNull();
    },
  );
});
