ALTER TABLE "usage_events" DROP CONSTRAINT "usage_events_tokens_non_negative";--> statement-breakpoint
ALTER TABLE "model_pricing" ADD COLUMN "cache_write_per_mtok_usd" numeric(12, 6);--> statement-breakpoint
ALTER TABLE "model_pricing" ADD COLUMN "long_context_threshold_tokens" integer;--> statement-breakpoint
ALTER TABLE "model_pricing" ADD COLUMN "long_input_per_mtok_usd" numeric(12, 6);--> statement-breakpoint
ALTER TABLE "model_pricing" ADD COLUMN "long_output_per_mtok_usd" numeric(12, 6);--> statement-breakpoint
ALTER TABLE "model_pricing" ADD COLUMN "long_cached_input_per_mtok_usd" numeric(12, 6);--> statement-breakpoint
ALTER TABLE "model_pricing" ADD COLUMN "long_cache_write_per_mtok_usd" numeric(12, 6);--> statement-breakpoint
ALTER TABLE "usage_events" ADD COLUMN "cache_write_input_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "model_pricing" ADD CONSTRAINT "model_pricing_long_context_complete" CHECK (("model_pricing"."long_context_threshold_tokens" IS NULL AND "model_pricing"."long_input_per_mtok_usd" IS NULL AND "model_pricing"."long_output_per_mtok_usd" IS NULL AND "model_pricing"."long_cached_input_per_mtok_usd" IS NULL AND "model_pricing"."long_cache_write_per_mtok_usd" IS NULL) OR ("model_pricing"."long_context_threshold_tokens" > 0 AND "model_pricing"."long_input_per_mtok_usd" IS NOT NULL AND "model_pricing"."long_output_per_mtok_usd" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_tokens_non_negative" CHECK ("usage_events"."input_tokens" >= 0 AND "usage_events"."output_tokens" >= 0 AND "usage_events"."cached_input_tokens" >= 0 AND "usage_events"."cache_write_input_tokens" >= 0);