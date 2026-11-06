ALTER TABLE "model_pricing" DROP CONSTRAINT "model_pricing_batch_multiplier_range";--> statement-breakpoint
ALTER TABLE "usage_events" DROP CONSTRAINT "usage_events_service_tier_valid";--> statement-breakpoint
DROP INDEX "model_pricing_provider_model_from_idx";--> statement-breakpoint
ALTER TABLE "model_pricing" ADD COLUMN "service_tier" text DEFAULT 'standard' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "model_pricing_provider_model_tier_from_idx" ON "model_pricing" USING btree ("provider","model","service_tier","effective_from");--> statement-breakpoint
ALTER TABLE "model_pricing" ADD CONSTRAINT "model_pricing_service_tier_valid" CHECK ("model_pricing"."service_tier" in ('standard', 'flex', 'fast'));--> statement-breakpoint
ALTER TABLE "model_pricing" ADD CONSTRAINT "model_pricing_batch_multiplier_range" CHECK ("model_pricing"."batch_multiplier" IS NULL OR ("model_pricing"."service_tier" = 'standard' AND "model_pricing"."batch_multiplier" > 0 AND "model_pricing"."batch_multiplier" <= 1));--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_service_tier_valid" CHECK ("usage_events"."service_tier" in ('standard', 'batch', 'flex', 'fast'));