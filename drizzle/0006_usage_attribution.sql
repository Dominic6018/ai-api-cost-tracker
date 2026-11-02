ALTER TABLE "usage_events" ADD COLUMN "customer_id" text;--> statement-breakpoint
ALTER TABLE "usage_events" ADD COLUMN "user_id" text;--> statement-breakpoint
ALTER TABLE "usage_events" ADD COLUMN "feature" text;--> statement-breakpoint
ALTER TABLE "usage_events" ADD COLUMN "run_id" text;--> statement-breakpoint
CREATE INDEX "usage_events_project_customer_idx" ON "usage_events" USING btree ("project_id","customer_id","occurred_at");--> statement-breakpoint
CREATE INDEX "usage_events_project_feature_idx" ON "usage_events" USING btree ("project_id","feature","occurred_at");--> statement-breakpoint
CREATE INDEX "usage_events_project_run_idx" ON "usage_events" USING btree ("project_id","run_id");