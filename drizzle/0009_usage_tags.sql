ALTER TABLE "usage_events" ADD COLUMN "tags" jsonb;--> statement-breakpoint
CREATE INDEX "usage_events_tags_idx" ON "usage_events" USING gin ("tags" jsonb_path_ops);