ALTER TABLE "model_pricing" ADD COLUMN "end_source_url" text;--> statement-breakpoint
ALTER TABLE "model_pricing" ADD COLUMN "end_checked_on" date;--> statement-breakpoint
ALTER TABLE "model_pricing" ADD COLUMN "ended_by" uuid;--> statement-breakpoint
ALTER TABLE "model_pricing" ADD CONSTRAINT "model_pricing_ended_by_users_id_fk" FOREIGN KEY ("ended_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_pricing" ADD CONSTRAINT "model_pricing_end_source_url_http" CHECK ("model_pricing"."end_source_url" IS NULL OR "model_pricing"."end_source_url" ~ '^https?://');