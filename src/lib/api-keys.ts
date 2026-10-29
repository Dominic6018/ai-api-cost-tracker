import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** Every key starts with this, so leaked keys are easy to recognise and scan for. */
export const API_KEY_MARKER = "act_";

const SECRET_BYTES = 32;
/** base64url length of SECRET_BYTES without padding. */
const SECRET_LENGTH = 43;
/** Characters of the key stored in plain text for display and lookup. */
export const API_KEY_PREFIX_LENGTH = API_KEY_MARKER.length + 8;

const KEY_PATTERN = new RegExp(
  `^${API_KEY_MARKER}[A-Za-z0-9_-]{${SECRET_LENGTH}}$`,
);

export interface GeneratedApiKey {
  /** The full key. Show it once; it is not stored. */
  key: string;
  prefix: string;
  hash: string;
}

/** Hex-encoded SHA-256 of a key. Keys carry 256 bits of entropy, so a fast hash is enough. */
export function hashApiKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

export function apiKeyPrefix(key: string): string {
  return key.slice(0, API_KEY_PREFIX_LENGTH);
}

/** Creates a new key from a cryptographically secure random source. */
export function generateApiKey(): GeneratedApiKey {
  const key = API_KEY_MARKER + randomBytes(SECRET_BYTES).toString("base64url");
  return { key, prefix: apiKeyPrefix(key), hash: hashApiKey(key) };
}

export function isWellFormedApiKey(key: string): boolean {
  return KEY_PATTERN.test(key);
}

/** Compares a presented key against a stored hash in constant time. */
export function apiKeyMatchesHash(key: string, storedHash: string): boolean {
  const presented = Buffer.from(hashApiKey(key), "hex");
  const stored = Buffer.from(storedHash, "hex");
  return (
    presented.length === stored.length && timingSafeEqual(presented, stored)
  );
}

/** Extracts the key from an `Authorization: Bearer <key>` header. */
export function parseBearerToken(header: string | null): string | null {
  const match = header?.match(/^Bearer[ \t]+(\S+)[ \t]*$/i);
  return match ? match[1] : null;
}
