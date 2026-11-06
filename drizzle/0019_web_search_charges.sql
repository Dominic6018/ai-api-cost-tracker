ALTER TABLE "model_pricing" ADD COLUMN "web_search_per_1k_usd" numeric(12, 6);--> statement-breakpoint
ALTER TABLE "usage_events" ADD COLUMN "web_search_requests" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_events" ADD COLUMN "web_search_cost_usd" numeric(14, 6) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_web_search_valid" CHECK ("usage_events"."web_search_requests" >= 0 AND "usage_events"."web_search_cost_usd" >= 0 AND "usage_events"."web_search_cost_usd" <= "usage_events"."cost_usd");