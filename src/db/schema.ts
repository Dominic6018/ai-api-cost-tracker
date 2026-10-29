import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const providerEnum = pgEnum("provider", [
  "openai",
  "anthropic",
  "google",
  "mistral",
  "other",
]);

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

/** A logical grouping of API usage (an app, team, or environment). */
export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    // Optional monthly budget in USD; null means no budget configured.
    monthlyBudgetUsd: numeric("monthly_budget_usd", {
      precision: 12,
      scale: 2,
    }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("projects_slug_idx").on(t.slug),
    check(
      "projects_budget_non_negative",
      sql`${t.monthlyBudgetUsd} IS NULL OR ${t.monthlyBudgetUsd} >= 0`,
    ),
  ],
);

/**
 * Per-model token prices, versioned by effective date so historical usage
 * keeps the price that applied when it occurred. Prices are USD per 1M tokens.
 */
export const modelPricing = pgTable(
  "model_pricing",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: providerEnum("provider").notNull(),
    model: text("model").notNull(),
    inputPerMTokUsd: numeric("input_per_mtok_usd", {
      precision: 12,
      scale: 6,
    }).notNull(),
    outputPerMTokUsd: numeric("output_per_mtok_usd", {
      precision: 12,
      scale: 6,
    }).notNull(),
    // Null when the model has no discounted cached-input rate.
    cachedInputPerMTokUsd: numeric("cached_input_per_mtok_usd", {
      precision: 12,
      scale: 6,
    }),
    effectiveFrom: timestamp("effective_from", { withTimezone: true })
      .notNull()
      .defaultNow(),
    effectiveTo: timestamp("effective_to", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("model_pricing_provider_model_from_idx").on(
      t.provider,
      t.model,
      t.effectiveFrom,
    ),
    check(
      "model_pricing_effective_range",
      sql`${t.effectiveTo} IS NULL OR ${t.effectiveTo} > ${t.effectiveFrom}`,
    ),
  ],
);

/** One recorded API call (or aggregated batch) and its computed cost. */
export const usageEvents = pgTable(
  "usage_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    provider: providerEnum("provider").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cachedInputTokens: integer("cached_input_tokens").notNull().default(0),
    costUsd: numeric("cost_usd", { precision: 14, scale: 6 }).notNull(),
    // Provider request id, used to de-duplicate ingested events.
    requestId: text("request_id"),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamps.createdAt,
  },
  (t) => [
    index("usage_events_project_occurred_idx").on(t.projectId, t.occurredAt),
    index("usage_events_provider_model_idx").on(t.provider, t.model),
    uniqueIndex("usage_events_provider_request_idx")
      .on(t.provider, t.requestId)
      .where(sql`${t.requestId} IS NOT NULL`),
    check(
      "usage_events_tokens_non_negative",
      sql`${t.inputTokens} >= 0 AND ${t.outputTokens} >= 0 AND ${t.cachedInputTokens} >= 0`,
    ),
  ],
);

/**
 * Per-project credentials for the ingestion API. Only a SHA-256 hash of the
 * key is stored; the key itself is shown once, when it is created.
 */
export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // Leading characters of the key, safe to display and used for lookup.
    keyPrefix: text("key_prefix").notNull(),
    // Hex-encoded SHA-256 of the full key.
    keyHash: text("key_hash").notNull(),
    createdAt: timestamps.createdAt,
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("api_keys_key_prefix_idx").on(t.keyPrefix),
    uniqueIndex("api_keys_key_hash_idx").on(t.keyHash),
    index("api_keys_project_idx").on(t.projectId),
  ],
);

/** Dashboard accounts. Passwords are stored as scrypt hashes only. */
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Stored lowercased, so lookups are case-insensitive.
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    ...timestamps,
  },
  (t) => [uniqueIndex("users_email_idx").on(t.email)],
);

/**
 * Signed-in dashboard sessions. The cookie holds a random token; only its
 * SHA-256 hash is stored, so a database leak doesn't expose live sessions.
 */
export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    createdAt: timestamps.createdAt,
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("sessions_token_hash_idx").on(t.tokenHash),
    index("sessions_user_idx").on(t.userId),
  ],
);

export type Provider = (typeof providerEnum.enumValues)[number];
export type User = typeof users.$inferSelect;
export type ApiKey = typeof apiKeys.$inferSelect;
export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
export type ModelPricing = typeof modelPricing.$inferSelect;
export type NewModelPricing = typeof modelPricing.$inferInsert;
export type UsageEvent = typeof usageEvents.$inferSelect;
export type NewUsageEvent = typeof usageEvents.$inferInsert;
