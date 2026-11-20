import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  foreignKey,
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
/**
 * Where projects and accounts go unless told otherwise. Its admins are the
 * install's owners; see src/lib/roles.ts.
 */
export const DEFAULT_ORGANIZATION_ID = "00000000-0000-0000-0000-000000000001";

export const organizations = pgTable(
  "organizations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    ...timestamps,
  },
  (t) => [uniqueIndex("organizations_slug_idx").on(t.slug)],
);

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .default(DEFAULT_ORGANIZATION_ID)
      .references(() => organizations.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    // Optional monthly budget in USD; null means no budget configured.
    monthlyBudgetUsd: numeric("monthly_budget_usd", {
      precision: 12,
      scale: 2,
    }),
    // Optional cap on any one agent run's total spend (by run_id), in USD.
    runBudgetUsd: numeric("run_budget_usd", { precision: 12, scale: 2 }),
    ...timestamps,
  },
  (t) => [
    index("projects_organization_id_idx").on(t.organizationId),
    // Per organization: two organizations can both have "web-app".
    uniqueIndex("projects_organization_slug_idx").on(t.organizationId, t.slug),
    check(
      "projects_budget_non_negative",
      sql`${t.monthlyBudgetUsd} IS NULL OR ${t.monthlyBudgetUsd} >= 0`,
    ),
    check(
      "projects_run_budget_non_negative",
      sql`${t.runBudgetUsd} IS NULL OR ${t.runBudgetUsd} >= 0`,
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
    // Price for writing to the prompt cache; null bills writes as input.
    cacheWritePerMTokUsd: numeric("cache_write_per_mtok_usd", {
      precision: 12,
      scale: 6,
    }),
    // Price for 1-hour cache writes, where a provider charges more for a
    // longer TTL (Anthropic: 2× input, against 1.25× for 5 minutes); null
    // bills them like other cache writes.
    cacheWrite1hPerMTokUsd: numeric("cache_write_1h_per_mtok_usd", {
      precision: 12,
      scale: 6,
    }),
    // Prompt-length tier: a request whose input tokens (including cached
    // and cache-write tokens) exceed the threshold pays the long rates for
    // the whole request. All long_* columns are null for untiered models.
    longContextThresholdTokens: integer("long_context_threshold_tokens"),
    longInputPerMTokUsd: numeric("long_input_per_mtok_usd", {
      precision: 12,
      scale: 6,
    }),
    longOutputPerMTokUsd: numeric("long_output_per_mtok_usd", {
      precision: 12,
      scale: 6,
    }),
    longCachedInputPerMTokUsd: numeric("long_cached_input_per_mtok_usd", {
      precision: 12,
      scale: 6,
    }),
    longCacheWritePerMTokUsd: numeric("long_cache_write_per_mtok_usd", {
      precision: 12,
      scale: 6,
    }),
    longCacheWrite1hPerMTokUsd: numeric("long_cache_write_1h_per_mtok_usd", {
      precision: 12,
      scale: 6,
    }),
    // Batch requests cost this share of the standard price, every rate
    // included (Anthropic's Batch API: 0.5). Null when no batch price is
    // configured, and batch usage for the model is refused.
    batchMultiplier: numeric("batch_multiplier", { precision: 4, scale: 3 }),
    // Charged per 1,000 web searches, on top of tokens (Anthropic: $10).
    // Null when searches aren't priced, and usage with searches is refused.
    webSearchPer1kUsd: numeric("web_search_per_1k_usd", {
      precision: 12,
      scale: 6,
    }),
    // Audio tokens' own rates (OpenAI's audio and realtime models charge
    // far more for audio than text). Null when audio isn't priced, and usage
    // with audio tokens is refused. The long-prompt tier doesn't change them.
    audioInputPerMTokUsd: numeric("audio_input_per_mtok_usd", {
      precision: 12,
      scale: 6,
    }),
    // Falls back to the audio input rate.
    cachedAudioInputPerMTokUsd: numeric("cached_audio_input_per_mtok_usd", {
      precision: 12,
      scale: 6,
    }),
    audioOutputPerMTokUsd: numeric("audio_output_per_mtok_usd", {
      precision: 12,
      scale: 6,
    }),
    // Image tokens' own rates (OpenAI's image generation models). Each
    // falls back to the matching text rate, as vision models bill image
    // input as text. The long-prompt tier doesn't change them.
    imageInputPerMTokUsd: numeric("image_input_per_mtok_usd", {
      precision: 12,
      scale: 6,
    }),
    cachedImageInputPerMTokUsd: numeric("cached_image_input_per_mtok_usd", {
      precision: 12,
      scale: 6,
    }),
    imageOutputPerMTokUsd: numeric("image_output_per_mtok_usd", {
      precision: 12,
      scale: 6,
    }),
    // The processing tier these rates are for: "standard", or a provider's
    // "flex" (cheaper, slower) or "fast" (premium; OpenAI's former priority
    // processing, Anthropic's fast mode), each with its own published rates.
    serviceTier: text("service_tier")
      .$type<PriceTier>()
      .notNull()
      .default("standard"),
    effectiveFrom: timestamp("effective_from", { withTimezone: true })
      .notNull()
      .defaultNow(),
    effectiveTo: timestamp("effective_to", { withTimezone: true }),
    // Where the price was read (the provider's pricing page) and the day it
    // was last checked there. Null for rows recorded before these existed.
    sourceUrl: text("source_url"),
    checkedOn: date("checked_on", { mode: "string" }),
    // The user who added the price from /prices; null for seeded prices,
    // and kept (as null) if the account is deleted.
    recordedBy: uuid("recorded_by").references(() => users.id, {
      onDelete: "set null",
    }),
    // Set when the price was ended from /prices without a replacement (a
    // retired model): where that was read, when it was checked, and by
    // whom. The price's own source above is kept.
    endSourceUrl: text("end_source_url"),
    endCheckedOn: date("end_checked_on", { mode: "string" }),
    endedBy: uuid("ended_by").references(() => users.id, {
      onDelete: "set null",
    }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("model_pricing_provider_model_tier_from_idx").on(
      t.provider,
      t.model,
      t.serviceTier,
      t.effectiveFrom,
    ),
    check(
      "model_pricing_service_tier_valid",
      sql`${t.serviceTier} in ('standard', 'flex', 'fast')`,
    ),
    // Batch is a discount on the standard price, so only standard rows
    // carry it.
    check(
      "model_pricing_batch_multiplier_range",
      sql`${t.batchMultiplier} IS NULL OR (${t.serviceTier} = 'standard' AND ${t.batchMultiplier} > 0 AND ${t.batchMultiplier} <= 1)`,
    ),
    check(
      "model_pricing_source_url_http",
      sql`${t.sourceUrl} IS NULL OR ${t.sourceUrl} ~ '^https?://'`,
    ),
    check(
      "model_pricing_end_source_url_http",
      sql`${t.endSourceUrl} IS NULL OR ${t.endSourceUrl} ~ '^https?://'`,
    ),
    check(
      "model_pricing_effective_range",
      sql`${t.effectiveTo} IS NULL OR ${t.effectiveTo} > ${t.effectiveFrom}`,
    ),
    // A threshold needs long input and output rates; without one, no long
    // rates may be set.
    // Audio input and output rates come together; a cached audio rate
    // needs them.
    check(
      "model_pricing_audio_complete",
      sql`(${t.audioInputPerMTokUsd} IS NULL AND ${t.audioOutputPerMTokUsd} IS NULL AND ${t.cachedAudioInputPerMTokUsd} IS NULL) OR (${t.audioInputPerMTokUsd} IS NOT NULL AND ${t.audioOutputPerMTokUsd} IS NOT NULL)`,
    ),
    check(
      "model_pricing_long_context_complete",
      sql`(${t.longContextThresholdTokens} IS NULL AND ${t.longInputPerMTokUsd} IS NULL AND ${t.longOutputPerMTokUsd} IS NULL AND ${t.longCachedInputPerMTokUsd} IS NULL AND ${t.longCacheWritePerMTokUsd} IS NULL AND ${t.longCacheWrite1hPerMTokUsd} IS NULL) OR (${t.longContextThresholdTokens} > 0 AND ${t.longInputPerMTokUsd} IS NOT NULL AND ${t.longOutputPerMTokUsd} IS NOT NULL)`,
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
    // Portion of inputTokens written to the prompt cache.
    cacheWriteInputTokens: integer("cache_write_input_tokens")
      .notNull()
      .default(0),
    // The part of cache_write_input_tokens written with a 1-hour TTL.
    cacheWrite1hInputTokens: integer("cache_write_1h_input_tokens")
      .notNull()
      .default(0),
    // "standard"; "batch" for a provider's discounted Batch API (the standard
    // price times its batch multiplier); or "flex" or "fast", priced from
    // that tier's own price rows.
    serviceTier: text("service_tier")
      .$type<ServiceTier>()
      .notNull()
      .default("standard"),
    // Web searches the request ran, and the part of cost_usd they cost
    // (charged per search, on top of tokens).
    webSearchRequests: integer("web_search_requests").notNull().default(0),
    // Audio tokens, billed at the price's audio rates: part of input_tokens,
    // of cached_input_tokens (and of the audio input), and of output_tokens.
    audioInputTokens: integer("audio_input_tokens").notNull().default(0),
    cachedAudioInputTokens: integer("cached_audio_input_tokens")
      .notNull()
      .default(0),
    audioOutputTokens: integer("audio_output_tokens").notNull().default(0),
    // Image tokens, billed at the price's image rates (or text rates without
    // them): parts of the same totals, alongside any audio.
    imageInputTokens: integer("image_input_tokens").notNull().default(0),
    cachedImageInputTokens: integer("cached_image_input_tokens")
      .notNull()
      .default(0),
    imageOutputTokens: integer("image_output_tokens").notNull().default(0),
    webSearchCostUsd: numeric("web_search_cost_usd", {
      precision: 14,
      scale: 6,
    })
      .notNull()
      .default("0"),
    // Null while the event is unpriced: kept, but out of every total.
    costUsd: numeric("cost_usd", { precision: 14, scale: 6 }),
    pricingStatus: text("pricing_status")
      .$type<PricingStatus>()
      .notNull()
      .default("priced"),
    // Which price was missing; set only while unpriced.
    unpricedReason: text("unpriced_reason").$type<UnpricedReason>(),
    // Provider request id, used to de-duplicate ingested events.
    requestId: text("request_id"),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    // Optional attribution chosen by the caller (see src/lib/attribution.ts).
    customerId: text("customer_id"),
    // The end user in the caller's app, not a dashboard account.
    userId: text("user_id"),
    feature: text("feature"),
    runId: text("run_id"),
    // Free-form string labels (see src/lib/tags.ts); filterable, unlike metadata.
    tags: jsonb("tags").$type<Record<string, string>>(),
    createdAt: timestamps.createdAt,
  },
  (t) => [
    index("usage_events_project_occurred_idx").on(t.projectId, t.occurredAt),
    // Serves tag filters, which use jsonb containment (@>).
    index("usage_events_tags_idx").using("gin", t.tags.op("jsonb_path_ops")),
    // Cost by customer, feature or run, within a project and time range.
    index("usage_events_project_customer_idx").on(
      t.projectId,
      t.customerId,
      t.occurredAt,
    ),
    index("usage_events_project_feature_idx").on(
      t.projectId,
      t.feature,
      t.occurredAt,
    ),
    index("usage_events_project_run_idx").on(t.projectId, t.runId),
    // Spend totals across all projects filter by time alone.
    index("usage_events_occurred_idx").on(t.occurredAt),
    index("usage_events_provider_model_idx").on(t.provider, t.model),
    // Serves the overview's unpriced count and repricing.
    index("usage_events_unpriced_idx")
      .on(t.projectId, t.occurredAt)
      .where(sql`${t.pricingStatus} = 'unpriced'`),
    check(
      "usage_events_pricing_status_valid",
      sql`(${t.pricingStatus} = 'priced' and ${t.costUsd} is not null and ${t.unpricedReason} is null) or (${t.pricingStatus} = 'unpriced' and ${t.costUsd} is null and ${t.unpricedReason} is not null and ${t.unpricedReason} in ('no_pricing', 'no_tier_pricing', 'no_batch_pricing', 'no_audio_pricing', 'no_web_search_pricing'))`,
    ),
    check(
      "usage_events_service_tier_valid",
      sql`${t.serviceTier} in ('standard', 'batch', 'flex', 'fast')`,
    ),
    check(
      "usage_events_web_search_valid",
      sql`${t.webSearchRequests} >= 0 AND ${t.webSearchCostUsd} >= 0 AND ${t.webSearchCostUsd} <= ${t.costUsd}`,
    ),
    check(
      "usage_events_audio_valid",
      sql`${t.cachedAudioInputTokens} >= 0 AND ${t.cachedAudioInputTokens} <= ${t.audioInputTokens} AND ${t.cachedAudioInputTokens} <= ${t.cachedInputTokens} AND (${t.audioInputTokens} = 0 OR ${t.audioInputTokens} - ${t.cachedAudioInputTokens} <= ${t.inputTokens} - ${t.cachedInputTokens} - ${t.cacheWriteInputTokens}) AND ${t.audioOutputTokens} >= 0 AND ${t.audioOutputTokens} <= ${t.outputTokens}`,
    ),
    // Audio and image tokens together fit within the totals. Only rows with
    // image tokens are constrained, so existing rows can't block this.
    check(
      "usage_events_image_valid",
      sql`${t.cachedImageInputTokens} >= 0 AND ${t.cachedImageInputTokens} <= ${t.imageInputTokens} AND ${t.imageOutputTokens} >= 0 AND (${t.imageInputTokens} = 0 AND ${t.imageOutputTokens} = 0 OR (${t.cachedAudioInputTokens} + ${t.cachedImageInputTokens} <= ${t.cachedInputTokens} AND ${t.audioInputTokens} - ${t.cachedAudioInputTokens} + ${t.imageInputTokens} - ${t.cachedImageInputTokens} <= ${t.inputTokens} - ${t.cachedInputTokens} - ${t.cacheWriteInputTokens} AND ${t.audioOutputTokens} + ${t.imageOutputTokens} <= ${t.outputTokens}))`,
    ),
    // Per project, so no project can block or detect another's events.
    uniqueIndex("usage_events_project_provider_request_idx")
      .on(t.projectId, t.provider, t.requestId)
      .where(sql`${t.requestId} IS NOT NULL`),
    check(
      "usage_events_tokens_non_negative",
      sql`${t.inputTokens} >= 0 AND ${t.outputTokens} >= 0 AND ${t.cachedInputTokens} >= 0 AND ${t.cacheWriteInputTokens} >= 0`,
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
    // "ingest" keys send usage; "read" keys read reports. A key does one or
    // the other, so a key leaked from an app can't read cost data.
    scope: text("scope").$type<ApiKeyScope>().notNull().default("ingest"),
  },
  (t) => [
    check("api_keys_scope_valid", sql`${t.scope} in ('ingest', 'read')`),
    uniqueIndex("api_keys_key_prefix_idx").on(t.keyPrefix),
    uniqueIndex("api_keys_key_hash_idx").on(t.keyHash),
    index("api_keys_project_idx").on(t.projectId),
  ],
);

/** Dashboard accounts. Passwords are stored as scrypt hashes only. */
export const USER_ROLES = ["admin", "member", "viewer"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Stored lowercased, so lookups are case-insensitive.
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    // Set by the database until the app chooses one.
    organizationId: uuid("organization_id")
      .notNull()
      .default(DEFAULT_ORGANIZATION_ID)
      .references(() => organizations.id, { onDelete: "restrict" }),
    // The single sign-on provider's subject, bound at the first SSO sign-in.
    oidcSubject: text("oidc_subject"),
    // What the account may change; see src/lib/roles.ts.
    role: text("role").$type<UserRole>().notNull().default("admin"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("users_email_idx").on(t.email),
    uniqueIndex("users_oidc_subject_idx")
      .on(t.oidcSubject)
      .where(sql`${t.oidcSubject} is not null`),
    index("users_organization_id_idx").on(t.organizationId),
    check("users_role_valid", sql`${t.role} in ('admin', 'member', 'viewer')`),
  ],
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

/**
 * Invitations to join an organization, by single-use link. Only a hash of
 * the link's token is stored. One pending invitation per email at a time.
 */
export const accountInvitations = pgTable(
  "account_invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    // Stored lowercased, like users.email.
    email: text("email").notNull(),
    role: text("role").$type<UserRole>().notNull(),
    tokenHash: text("token_hash").notNull(),
    // Who invited, kept by email if their account is later deleted.
    invitedBy: uuid("invited_by").references(() => users.id, {
      onDelete: "set null",
    }),
    invitedByLabel: text("invited_by_label").notNull(),
    createdAt: timestamps.createdAt,
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    acceptedUserId: uuid("accepted_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    check(
      "account_invitations_role_valid",
      sql`${t.role} in ('admin', 'member', 'viewer')`,
    ),
    check(
      "account_invitations_closed_once",
      sql`${t.acceptedAt} is null or ${t.revokedAt} is null`,
    ),
    uniqueIndex("account_invitations_token_hash_idx").on(t.tokenHash),
    uniqueIndex("account_invitations_pending_email_idx")
      .on(t.email)
      .where(sql`${t.acceptedAt} is null and ${t.revokedAt} is null`),
    index("account_invitations_organization_idx").on(t.organizationId),
  ],
);

/**
 * Business outcomes, such as a resolved ticket or a completed order, so
 * cost can be divided by what it achieved. Attributed like usage events.
 */
export const outcomes = pgTable(
  "outcomes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    // e.g. "ticket_resolved"; cost per outcome is per name.
    name: text("name").notNull(),
    count: integer("count").notNull().default(1),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // The caller's ID for the outcome, so retries don't count it twice.
    outcomeId: text("outcome_id"),
    customerId: text("customer_id"),
    userId: text("user_id"),
    feature: text("feature"),
    runId: text("run_id"),
    createdAt: timestamps.createdAt,
  },
  (t) => [
    index("outcomes_project_name_occurred_idx").on(
      t.projectId,
      t.name,
      t.occurredAt,
    ),
    uniqueIndex("outcomes_project_outcome_id_idx").on(t.projectId, t.outcomeId),
    check("outcomes_count_positive", sql`${t.count} > 0`),
  ],
);

/**
 * Fixed-window counters for rate limiting sign-in and API-key checks. Keys
 * hold a SHA-256 hash, so attempted emails and client IPs aren't stored.
 */
export const rateLimits = pgTable(
  "rate_limits",
  {
    key: text("key").primaryKey(),
    count: integer("count").notNull(),
    resetAt: timestamp("reset_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("rate_limits_reset_at_idx").on(t.resetAt)],
);

/** How a request was processed, which decides its price. */
export const PRICING_STATUSES = ["priced", "unpriced"] as const;
export type PricingStatus = (typeof PRICING_STATUSES)[number];

/** The price an unpriced event is waiting for. */
export const UNPRICED_REASONS = [
  "no_pricing",
  "no_tier_pricing",
  "no_batch_pricing",
  "no_audio_pricing",
  "no_web_search_pricing",
] as const;
export type UnpricedReason = (typeof UNPRICED_REASONS)[number];

export const SERVICE_TIERS = ["standard", "batch", "flex", "fast"] as const;
export type ServiceTier = (typeof SERVICE_TIERS)[number];

/** The tiers with their own price rows; batch uses the standard row. */
export const PRICE_TIERS = ["standard", "flex", "fast"] as const;
export type PriceTier = (typeof PRICE_TIERS)[number];

export const AUDIT_ACTIONS = [
  "project.created",
  "project.updated",
  "price.added",
  "price.ended",
  "account.created",
  "account.role_changed",
  "account.password_reset",
  "account.sessions_revoked",
  "api_key.created",
  "api_key.revoked",
  "organization.created",
  "account.organization_changed",
  "usage.repriced",
  "billing.customer_created",
  "billing.adjusted",
  "billing.reversed",
  "billing.plan_created",
  "billing.subscribed",
  "billing.unsubscribed",
  "billing.charged",
  "billing.credit_granted",
  "billing.credits_applied",
  "billing.credit_refunded",
  "billing.stripe_invoiced",
  "billing.stripe_paid",
  "account.invited",
  "account.invitation_revoked",
  "billing.portal_link_created",
  "billing.portal_link_revoked",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/**
 * Who changed what. Written in the same transaction as the change. Holds
 * names and amounts only, never passwords, hashes, keys or session tokens.
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Null for the command line, or once the account has been deleted.
    actorUserId: uuid("actor_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    // Whose log it's in. Command-line changes go in the default one for now.
    organizationId: uuid("organization_id")
      .notNull()
      .default(DEFAULT_ORGANIZATION_ID)
      .references(() => organizations.id, { onDelete: "restrict" }),
    // The email at the time, or "command line"; survives account deletion.
    actorLabel: text("actor_label").notNull(),
    action: text("action").$type<AuditAction>().notNull(),
    target: text("target").notNull(),
    details: jsonb("details").$type<Record<string, unknown>>(),
  },
  (t) => [
    index("audit_log_organization_occurred_idx").on(
      t.organizationId,
      t.occurredAt.desc(),
      t.id.desc(),
    ),
    check(
      "audit_log_action_valid",
      sql`${t.action} in ('project.created', 'project.updated', 'price.added', 'price.ended', 'account.created', 'account.role_changed', 'account.password_reset', 'account.sessions_revoked', 'api_key.created', 'api_key.revoked', 'organization.created', 'account.organization_changed', 'usage.repriced', 'billing.customer_created', 'billing.adjusted', 'billing.reversed', 'billing.plan_created', 'billing.subscribed', 'billing.unsubscribed', 'billing.charged', 'billing.credit_granted', 'billing.credits_applied', 'billing.credit_refunded', 'billing.stripe_invoiced', 'billing.stripe_paid', 'account.invited', 'account.invitation_revoked', 'billing.portal_link_created', 'billing.portal_link_revoked')`,
    ),
  ],
);

export const INGESTION_OUTCOMES = [
  "stored",
  "unpriced",
  "replayed",
  "conflict",
  "invalid",
] as const;
export type IngestionOutcome = (typeof INGESTION_OUTCOMES)[number];

/**
 * How many usage records each project sent per UTC day, by outcome, from
 * POST /api/usage and OpenTelemetry. One row per project, day and outcome,
 * incremented as requests arrive.
 */
export const ingestionCounts = pgTable(
  "ingestion_counts",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    day: date("day", { mode: "string" }).notNull(),
    outcome: text("outcome").$type<IngestionOutcome>().notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => [
    uniqueIndex("ingestion_counts_project_day_outcome_idx").on(
      t.projectId,
      t.day,
      t.outcome,
    ),
    index("ingestion_counts_day_idx").on(t.day),
    check(
      "ingestion_counts_outcome_valid",
      sql`${t.outcome} in ('stored', 'unpriced', 'replayed', 'conflict', 'invalid')`,
    ),
    check("ingestion_counts_count_valid", sql`${t.count} >= 0`),
  ],
);

export const RESERVATION_STATUSES = ["held", "released", "settled"] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

/**
 * Budget held for a step before it spends (POST /api/budget/reserve).
 * Unexpired holds count against the budgets like recorded spend, until
 * released, settled by recorded usage, or past `expires_at`.
 */
export const budgetReservations = pgTable(
  "budget_reservations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    // The caller's id for the hold; retries reuse it.
    reservationKey: text("reservation_key").notNull(),
    runId: text("run_id"),
    // The customer the step is for, whose plan limit the hold counts against.
    customerId: text("customer_id"),
    amountUsd: numeric("amount_usd", { precision: 14, scale: 6 }).notNull(),
    status: text("status").$type<ReservationStatus>().notNull().default("held"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("budget_reservations_project_key_idx").on(
      t.projectId,
      t.reservationKey,
    ),
    // Serves the sum of a project's unexpired holds.
    // Serves the sum of a customer's unexpired holds.
    index("budget_reservations_customer_held_idx")
      .on(t.customerId, t.expiresAt)
      .where(sql`${t.status} = 'held' and ${t.customerId} is not null`),
    index("budget_reservations_held_idx")
      .on(t.projectId, t.expiresAt)
      .where(sql`${t.status} = 'held'`),
    check(
      "budget_reservations_status_valid",
      sql`${t.status} in ('held', 'released', 'settled')`,
    ),
    check("budget_reservations_amount_valid", sql`${t.amountUsd} >= 0`),
    check(
      "budget_reservations_ended_valid",
      sql`(${t.status} = 'held') = (${t.endedAt} is null)`,
    ),
  ],
);

export const ALERT_CHANNELS = ["webhook", "slack", "email"] as const;
export type AlertChannel = (typeof ALERT_CHANNELS)[number];

/**
 * Budget notifications sent, at most one per project, month, threshold and
 * channel. A row is claimed before sending and removed if delivery fails,
 * so overlapping runs don't both send and a failure is retried.
 */
export const budgetNotifications = pgTable(
  "budget_notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    // The UTC month, e.g. "2026-11".
    period: text("period").notNull(),
    thresholdPercent: integer("threshold_percent").notNull(),
    channel: text("channel").$type<AlertChannel>().notNull(),
    // What the message said, for the record.
    spentUsd: numeric("spent_usd", { precision: 14, scale: 6 }).notNull(),
    budgetUsd: numeric("budget_usd", { precision: 12, scale: 2 }).notNull(),
    notifiedAt: timestamp("notified_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("budget_notifications_once_idx").on(
      t.projectId,
      t.period,
      t.thresholdPercent,
      t.channel,
    ),
    check(
      "budget_notifications_period_valid",
      sql`${t.period} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`,
    ),
    check(
      "budget_notifications_threshold_valid",
      sql`${t.thresholdPercent} in (80, 100)`,
    ),
    check(
      "budget_notifications_channel_valid",
      sql`${t.channel} in ('webhook', 'slack', 'email')`,
    ),
  ],
);

/**
 * Forecast and spike notifications sent: at most one per project, kind,
 * period (the month for a forecast, the UTC day for a spike) and channel.
 * Claimed before sending and removed if delivery fails, like
 * budget_notifications.
 */
export const spendSignalNotifications = pgTable(
  "spend_signal_notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    kind: text("kind").$type<"forecast" | "spike">().notNull(),
    // "2026-11" for a forecast, "2026-11-06" for a spike.
    period: text("period").notNull(),
    channel: text("channel").$type<AlertChannel>().notNull(),
    // What the message reported: the projected month or today's spend,
    // against the budget or the 7-day daily average.
    amountUsd: numeric("amount_usd", { precision: 14, scale: 6 }).notNull(),
    referenceUsd: numeric("reference_usd", {
      precision: 14,
      scale: 6,
    }).notNull(),
    notifiedAt: timestamp("notified_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("spend_signal_notifications_once_idx").on(
      t.projectId,
      t.kind,
      t.period,
      t.channel,
    ),
    check(
      "spend_signal_notifications_period_valid",
      sql`(${t.kind} = 'forecast' and ${t.period} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$') or (${t.kind} = 'spike' and ${t.period} ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$')`,
    ),
    check(
      "spend_signal_notifications_channel_valid",
      sql`${t.channel} in ('webhook', 'slack', 'email')`,
    ),
  ],
);

/**
 * Who an organization bills: one row per customer, keyed by the same
 * `customerId` its usage and outcomes are attributed to.
 */
export const billingCustomers = pgTable(
  "billing_customers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    // The customerId in usage events and outcomes.
    externalId: text("external_id").notNull(),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("billing_customers_organization_external_idx").on(
      t.organizationId,
      t.externalId,
    ),
    // The target of the ledger's (customer, organization) foreign key.
    uniqueIndex("billing_customers_id_organization_idx").on(
      t.id,
      t.organizationId,
    ),
    check(
      "billing_customers_external_id_valid",
      sql`char_length(${t.externalId}) between 1 and 200`,
    ),
    check(
      "billing_customers_name_valid",
      sql`char_length(${t.name}) between 1 and 200`,
    ),
  ],
);

/**
 * What a customer pays each month: a fee, usage allowance included in it,
 * and the rate for usage, as a multiple of its AI API cost. Plans don't
 * change once created, so a month is always billed on the terms it had.
 */
export const billingPlans = pgTable(
  "billing_plans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    monthlyFeeUsd: numeric("monthly_fee_usd", {
      precision: 14,
      scale: 6,
    }).notNull(),
    // Usage charges up to this each month are covered by the fee.
    includedUsageUsd: numeric("included_usage_usd", {
      precision: 14,
      scale: 6,
    }).notNull(),
    // Usage is charged at its AI API cost times this, e.g. 1.25.
    usageMultiplier: numeric("usage_multiplier", {
      precision: 10,
      scale: 4,
    }).notNull(),
    // The most AI API cost the customer's usage may reach in a month, which
    // budget checks naming the customer enforce; null for no limit.
    monthlyUsageLimitUsd: numeric("monthly_usage_limit_usd", {
      precision: 14,
      scale: 6,
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("billing_plans_organization_slug_idx").on(
      t.organizationId,
      t.slug,
    ),
    // The target of the subscriptions' (plan, organization) foreign key.
    uniqueIndex("billing_plans_id_organization_idx").on(t.id, t.organizationId),
    check(
      "billing_plans_name_valid",
      sql`char_length(${t.name}) between 1 and 200`,
    ),
    check(
      "billing_plans_amounts_valid",
      sql`${t.monthlyFeeUsd} >= 0 and ${t.includedUsageUsd} >= 0 and ${t.usageMultiplier} >= 0`,
    ),
    check(
      "billing_plans_usage_limit_valid",
      sql`${t.monthlyUsageLimitUsd} is null or ${t.monthlyUsageLimitUsd} >= 0`,
    ),
  ],
);

/**
 * Which plan a customer is on, by UTC calendar month: from `starts_on`
 * (the first of a month) until `ends_on` (the first of a later month,
 * exclusive), or open-ended. A customer's periods never overlap.
 */
export const billingSubscriptions = pgTable(
  "billing_subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    customerId: uuid("customer_id").notNull(),
    planId: uuid("plan_id").notNull(),
    startsOn: date("starts_on").notNull(),
    endsOn: date("ends_on"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Customer and plan are both in the subscription's organization.
    foreignKey({
      name: "billing_subscriptions_customer_fk",
      columns: [t.customerId, t.organizationId],
      foreignColumns: [billingCustomers.id, billingCustomers.organizationId],
    }).onDelete("cascade"),
    foreignKey({
      name: "billing_subscriptions_plan_fk",
      columns: [t.planId, t.organizationId],
      foreignColumns: [billingPlans.id, billingPlans.organizationId],
    }),
    // At most one open-ended subscription per customer.
    uniqueIndex("billing_subscriptions_open_idx")
      .on(t.customerId)
      .where(sql`${t.endsOn} is null`),
    index("billing_subscriptions_customer_idx").on(t.customerId, t.startsOn),
    check(
      "billing_subscriptions_months_valid",
      sql`extract(day from ${t.startsOn}) = 1 and (${t.endsOn} is null or (extract(day from ${t.endsOn}) = 1 and ${t.endsOn} > ${t.startsOn}))`,
    ),
  ],
);

export const BILLING_ENTRY_KINDS = [
  "adjustment",
  "reversal",
  "plan_fee",
  "usage_charge",
  "credit_applied",
  "payment",
] as const;
export type BillingEntryKind = (typeof BILLING_ENTRY_KINDS)[number];

/**
 * What customers are billed, separate from provider cost. Append-only: a
 * trigger refuses updates and deletes, so a correction is a new entry
 * that reverses the old one. Positive amounts are owed by the customer,
 * negative ones are owed to them.
 */
export const billingLedgerEntries = pgTable(
  "billing_ledger_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    customerId: uuid("customer_id").notNull(),
    kind: text("kind").$type<BillingEntryKind>().notNull(),
    amountUsd: numeric("amount_usd", { precision: 14, scale: 6 }).notNull(),
    description: text("description").notNull(),
    // The caller's id for the entry, so a retry doesn't add it twice.
    entryKey: text("entry_key"),
    // The entry a reversal cancels.
    reversesEntryId: uuid("reverses_entry_id"),
    // For a plan's monthly charges: the month billed (its first day), the
    // plan it was billed on and, for usage, the AI API cost it was based on.
    period: date("period"),
    planId: uuid("plan_id").references(() => billingPlans.id),
    usageCostUsd: numeric("usage_cost_usd", { precision: 14, scale: 6 }),
    // The account's email at the time, or "command line".
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // The customer must be in the entry's organization.
    foreignKey({
      name: "billing_ledger_entries_customer_fk",
      columns: [t.customerId, t.organizationId],
      foreignColumns: [billingCustomers.id, billingCustomers.organizationId],
    }),
    foreignKey({
      name: "billing_ledger_entries_reverses_fk",
      columns: [t.reversesEntryId],
      foreignColumns: [t.id],
    }),
    uniqueIndex("billing_ledger_entries_key_idx")
      .on(t.organizationId, t.entryKey)
      .where(sql`${t.entryKey} is not null`),
    // A month's fee and usage are each charged at most once.
    uniqueIndex("billing_ledger_entries_period_idx")
      .on(t.customerId, t.kind, t.period)
      .where(sql`${t.period} is not null`),
    // An entry is reversed at most once.
    uniqueIndex("billing_ledger_entries_reverses_idx")
      .on(t.reversesEntryId)
      .where(sql`${t.reversesEntryId} is not null`),
    index("billing_ledger_entries_customer_idx").on(
      t.customerId,
      t.createdAt.desc(),
      t.id.desc(),
    ),
    check(
      "billing_ledger_entries_kind_valid",
      sql`${t.kind} in ('adjustment', 'reversal', 'plan_fee', 'usage_charge', 'credit_applied', 'payment')`,
    ),
    check(
      "billing_ledger_entries_charge_valid",
      sql`(${t.kind} in ('plan_fee', 'usage_charge')) = (${t.period} is not null and ${t.planId} is not null) and (${t.period} is null or extract(day from ${t.period}) = 1) and (${t.kind} not in ('plan_fee', 'usage_charge') or ${t.amountUsd} > 0) and (${t.kind} = 'usage_charge') = (${t.usageCostUsd} is not null) and (${t.usageCostUsd} is null or ${t.usageCostUsd} >= 0)`,
    ),
    check("billing_ledger_entries_amount_valid", sql`${t.amountUsd} <> 0`),
    // Credits and payments reduce what's owed.
    check(
      "billing_ledger_entries_credit_valid",
      sql`${t.kind} not in ('credit_applied', 'payment') or ${t.amountUsd} < 0`,
    ),
    check(
      "billing_ledger_entries_description_valid",
      sql`char_length(${t.description}) between 1 and 500`,
    ),
    check(
      "billing_ledger_entries_entry_key_valid",
      sql`${t.entryKey} is null or char_length(${t.entryKey}) between 1 and 200`,
    ),
    check(
      "billing_ledger_entries_reversal_valid",
      sql`(${t.kind} = 'reversal') = (${t.reversesEntryId} is not null)`,
    ),
  ],
);

/**
 * Prepaid credit for a customer, used against what they owe until it runs
 * out or expires. Append-only, like the ledger: what's left is the amount
 * less its uses.
 */
export const billingCreditGrants = pgTable(
  "billing_credit_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    customerId: uuid("customer_id").notNull(),
    amountUsd: numeric("amount_usd", { precision: 14, scale: 6 }).notNull(),
    // Unused credit can't be used from this moment; null never expires.
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    description: text("description").notNull(),
    // The caller's id for the grant, so a retry doesn't grant twice.
    grantKey: text("grant_key"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "billing_credit_grants_customer_fk",
      columns: [t.customerId, t.organizationId],
      foreignColumns: [billingCustomers.id, billingCustomers.organizationId],
    }),
    // The target of the uses' (grant, customer, organization) foreign key.
    uniqueIndex("billing_credit_grants_owner_idx").on(
      t.id,
      t.customerId,
      t.organizationId,
    ),
    uniqueIndex("billing_credit_grants_key_idx")
      .on(t.organizationId, t.grantKey)
      .where(sql`${t.grantKey} is not null`),
    index("billing_credit_grants_customer_idx").on(t.customerId),
    check("billing_credit_grants_amount_valid", sql`${t.amountUsd} > 0`),
    check(
      "billing_credit_grants_description_valid",
      sql`char_length(${t.description}) between 1 and 500`,
    ),
    check(
      "billing_credit_grants_expiry_valid",
      sql`${t.expiresAt} is null or ${t.expiresAt} > ${t.createdAt}`,
    ),
  ],
);

export const CREDIT_USE_KINDS = ["applied", "refunded"] as const;
export type CreditUseKind = (typeof CREDIT_USE_KINDS)[number];

/**
 * Credit taken from a grant: applied to what the customer owes (with the
 * ledger entry that records it), or refunded, which withdraws unused
 * credit. A trigger refuses a use beyond what's left of the grant, or of a
 * grant that has expired. Append-only.
 */
export const billingCreditUses = pgTable(
  "billing_credit_uses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    customerId: uuid("customer_id").notNull(),
    grantId: uuid("grant_id").notNull(),
    kind: text("kind").$type<CreditUseKind>().notNull(),
    amountUsd: numeric("amount_usd", { precision: 14, scale: 6 }).notNull(),
    ledgerEntryId: uuid("ledger_entry_id").references(
      () => billingLedgerEntries.id,
    ),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // The grant is the customer's, in the use's organization.
    foreignKey({
      name: "billing_credit_uses_grant_fk",
      columns: [t.grantId, t.customerId, t.organizationId],
      foreignColumns: [
        billingCreditGrants.id,
        billingCreditGrants.customerId,
        billingCreditGrants.organizationId,
      ],
    }),
    index("billing_credit_uses_grant_idx").on(t.grantId),
    check(
      "billing_credit_uses_kind_valid",
      sql`${t.kind} in ('applied', 'refunded')`,
    ),
    check("billing_credit_uses_amount_valid", sql`${t.amountUsd} > 0`),
    check(
      "billing_credit_uses_entry_valid",
      sql`(${t.kind} = 'applied') = (${t.ledgerEntryId} is not null)`,
    ),
  ],
);

export const STRIPE_MODES = ["test", "live"] as const;
export type StripeMode = (typeof STRIPE_MODES)[number];

/**
 * A billing customer's customer in Stripe, per mode: test (sandbox) and
 * live accounts are separate, with separate customers.
 */
export const billingStripeCustomers = pgTable(
  "billing_stripe_customers",
  {
    customerId: uuid("customer_id")
      .notNull()
      .references(() => billingCustomers.id, { onDelete: "cascade" }),
    mode: text("mode").$type<StripeMode>().notNull(),
    stripeCustomerId: text("stripe_customer_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("billing_stripe_customers_customer_idx").on(
      t.customerId,
      t.mode,
    ),
    check(
      "billing_stripe_customers_mode_valid",
      sql`${t.mode} in ('test', 'live')`,
    ),
  ],
);

/**
 * Links that let one billing customer read their own statement, without
 * an account. Only a hash of the link's token is stored.
 */
export const billingPortalLinks = pgTable(
  "billing_portal_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    customerId: uuid("customer_id").notNull(),
    tokenHash: text("token_hash").notNull(),
    // Who made it, by email or "command line".
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastViewedAt: timestamp("last_viewed_at", { withTimezone: true }),
  },
  (t) => [
    // The customer, and only in its own organization.
    foreignKey({
      name: "billing_portal_links_customer_fk",
      columns: [t.customerId, t.organizationId],
      foreignColumns: [billingCustomers.id, billingCustomers.organizationId],
    }).onDelete("cascade"),
    uniqueIndex("billing_portal_links_token_hash_idx").on(t.tokenHash),
    index("billing_portal_links_customer_idx").on(t.customerId),
  ],
);

/**
 * A draft invoice created in Stripe for ledger entries not invoiced
 * before, in one mode. Append-only, like the ledger.
 */
export const billingStripeInvoices = pgTable(
  "billing_stripe_invoices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    customerId: uuid("customer_id").notNull(),
    mode: text("mode").$type<StripeMode>().notNull(),
    stripeInvoiceId: text("stripe_invoice_id").notNull(),
    // The sum of the items, in whole cents, as sent to Stripe.
    amountCents: bigint("amount_cents", { mode: "bigint" }).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "billing_stripe_invoices_customer_fk",
      columns: [t.customerId, t.organizationId],
      foreignColumns: [billingCustomers.id, billingCustomers.organizationId],
    }),
    uniqueIndex("billing_stripe_invoices_stripe_idx").on(t.stripeInvoiceId),
    index("billing_stripe_invoices_customer_idx").on(t.customerId),
    check(
      "billing_stripe_invoices_mode_valid",
      sql`${t.mode} in ('test', 'live')`,
    ),
    check("billing_stripe_invoices_amount_valid", sql`${t.amountCents} > 0`),
  ],
);

/**
 * Which invoice each ledger entry went out on, per mode: an entry is
 * invoiced at most once in each. Append-only.
 */
export const billingStripeInvoiceItems = pgTable(
  "billing_stripe_invoice_items",
  {
    ledgerEntryId: uuid("ledger_entry_id")
      .notNull()
      .references(() => billingLedgerEntries.id, { onDelete: "cascade" }),
    mode: text("mode").$type<StripeMode>().notNull(),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => billingStripeInvoices.id, { onDelete: "cascade" }),
    // Null for an entry that rounds to $0.00, which has no Stripe item.
    stripeItemId: text("stripe_item_id"),
    // The entry rounded to whole cents, as sent; the ledger keeps the
    // exact amount.
    amountCents: bigint("amount_cents", { mode: "bigint" }).notNull(),
  },
  (t) => [
    uniqueIndex("billing_stripe_invoice_items_entry_idx").on(
      t.ledgerEntryId,
      t.mode,
    ),
    index("billing_stripe_invoice_items_invoice_idx").on(t.invoiceId),
    check(
      "billing_stripe_invoice_items_mode_valid",
      sql`${t.mode} in ('test', 'live')`,
    ),
  ],
);

/**
 * Every Stripe webhook event received, by Stripe's event ID, so an event
 * Stripe delivers again is acknowledged without being applied twice.
 */
export const stripeWebhookEvents = pgTable(
  "stripe_webhook_events",
  {
    eventId: text("event_id").primaryKey(),
    type: text("type").notNull(),
    livemode: boolean("livemode").notNull(),
    // "recorded" for an invoice event of the tracker's; "ignored" for
    // anything else, such as an invoice made outside the tracker.
    outcome: text("outcome").$type<"recorded" | "ignored">().notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check(
      "stripe_webhook_events_outcome_valid",
      sql`${t.outcome} in ('recorded', 'ignored')`,
    ),
  ],
);

/**
 * What happened to an invoice in Stripe, one row per event, in the order
 * Stripe created them: the latest is its status. Append-only.
 */
export const billingStripeInvoiceEvents = pgTable(
  "billing_stripe_invoice_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => billingStripeInvoices.id, { onDelete: "cascade" }),
    stripeEventId: text("stripe_event_id").notNull(),
    status: text("status")
      .$type<"open" | "paid" | "payment_failed" | "void" | "uncollectible">()
      .notNull(),
    // For a payment: the cents Stripe says were paid.
    amountPaidCents: bigint("amount_paid_cents", { mode: "bigint" }),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("billing_stripe_invoice_events_event_idx").on(t.stripeEventId),
    index("billing_stripe_invoice_events_invoice_idx").on(
      t.invoiceId,
      t.occurredAt,
    ),
    check(
      "billing_stripe_invoice_events_status_valid",
      sql`${t.status} in ('open', 'paid', 'payment_failed', 'void', 'uncollectible')`,
    ),
    check(
      "billing_stripe_invoice_events_paid_valid",
      sql`${t.amountPaidCents} is null or ${t.amountPaidCents} >= 0`,
    ),
  ],
);

export const API_KEY_SCOPES = ["ingest", "read"] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export type Provider = (typeof providerEnum.enumValues)[number];
export type User = typeof users.$inferSelect;
export type AuditLogEntry = typeof auditLog.$inferSelect;
export type BudgetReservation = typeof budgetReservations.$inferSelect;
export type ApiKey = typeof apiKeys.$inferSelect;
export type Organization = typeof organizations.$inferSelect;
export type BillingCustomer = typeof billingCustomers.$inferSelect;
export type BillingLedgerEntry = typeof billingLedgerEntries.$inferSelect;
export type BillingPlan = typeof billingPlans.$inferSelect;
export type BillingSubscription = typeof billingSubscriptions.$inferSelect;
export type BillingCreditGrant = typeof billingCreditGrants.$inferSelect;
export type BillingCreditUse = typeof billingCreditUses.$inferSelect;
export type StripeInvoice = typeof billingStripeInvoices.$inferSelect;
export type StripeInvoiceEvent = typeof billingStripeInvoiceEvents.$inferSelect;
export type AccountInvitation = typeof accountInvitations.$inferSelect;
export type BillingPortalLink = typeof billingPortalLinks.$inferSelect;
export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
export type ModelPricing = typeof modelPricing.$inferSelect;
export type NewModelPricing = typeof modelPricing.$inferInsert;
export type UsageEvent = typeof usageEvents.$inferSelect;
export type Outcome = typeof outcomes.$inferSelect;
export type NewUsageEvent = typeof usageEvents.$inferInsert;
