import { z } from "zod";
import { ATTRIBUTION_FIELDS } from "./attribution";

/**
 * Free-form tags: string labels such as `env: prod` or `team: search`,
 * for slicing cost by anything the attribution fields don't cover.
 */
export type Tags = Record<string, string>;

export const MAX_TAGS = 20;
export const MAX_TAG_VALUE_LENGTH = 200;

/**
 * Letters, digits and `_ . / -`, up to 64 characters. No `:`, so a filter
 * written `key:value` splits unambiguously at its first colon.
 */
const TAG_KEY = /^[A-Za-z0-9_./-]{1,64}$/;

/** Attribution has its own fields; FOCUS exports put both in one object. */
const RESERVED_KEYS = new Set<string>(ATTRIBUTION_FIELDS.map((f) => f.key));

/**
 * zod's record parser silently drops a `__proto__` key, so it's rejected
 * before parsing rather than lost.
 */
const PROTO_KEY = "__proto__";

export const tagsSchema = z
  .unknown()
  .refine(
    (input) =>
      !(input && typeof input === "object" && Object.hasOwn(input, PROTO_KEY)),
    { message: `${PROTO_KEY} can't be a tag key` },
  )
  .pipe(
    z
      .record(
        z
          .string()
          .regex(TAG_KEY, "Tag keys are 1-64 letters, digits and _ . / -")
          .refine((key) => !RESERVED_KEYS.has(key), {
            message:
              "customerId, userId, feature and runId have their own fields",
          }),
        z.string().trim().min(1).max(MAX_TAG_VALUE_LENGTH),
      )
      .refine((tags) => Object.keys(tags).length <= MAX_TAGS, {
        message: `At most ${MAX_TAGS} tags`,
      }),
  );

const isTagKey = (key: string) =>
  TAG_KEY.test(key) && key !== PROTO_KEY && !RESERVED_KEYS.has(key);

/** Whether one tag would pass `tagsSchema`; `value` is already trimmed. */
export function isValidTag(key: string, value: string): boolean {
  return (
    isTagKey(key) && value.length >= 1 && value.length <= MAX_TAG_VALUE_LENGTH
  );
}

export interface TagFilter {
  key: string;
  value: string;
}

/** Reads a `key:value` filter, or undefined for anything else. */
export function parseTagFilter(text: string): TagFilter | undefined {
  const at = text.indexOf(":");
  if (at < 1) return undefined;
  const key = text.slice(0, at).trim();
  const value = text.slice(at + 1).trim();
  if (!TAG_KEY.test(key) || !value || value.length > MAX_TAG_VALUE_LENGTH) {
    return undefined;
  }
  return { key, value };
}

export const formatTagFilter = ({ key, value }: TagFilter) => `${key}:${value}`;
