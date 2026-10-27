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

export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
export type ModelPricing = typeof modelPricing.$inferSelect;
export type NewModelPricing = typeof modelPricing.$inferInsert;
export type UsageEvent = typeof usageEvents.$inferSelect;
export type NewUsageEvent = typeof usageEvents.$inferInsert;
