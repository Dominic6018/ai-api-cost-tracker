ALTER TABLE "model_pricing" ADD COLUMN "source_url" text;--> statement-breakpoint
ALTER TABLE "model_pricing" ADD COLUMN "checked_on" date;--> statement-breakpoint
ALTER TABLE "model_pricing" ADD CONSTRAINT "model_pricing_source_url_http" CHECK ("model_pricing"."source_url" IS NULL OR "model_pricing"."source_url" ~ '^https?://');