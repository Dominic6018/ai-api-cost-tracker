CREATE TYPE "public"."provider" AS ENUM('openai', 'anthropic', 'google', 'mistral', 'other');--> statement-breakpoint
CREATE TABLE "model_pricing" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" "provider" NOT NULL,
	"model" text NOT NULL,
	"input_per_mtok_usd" numeric(12, 6) NOT NULL,
	"output_per_mtok_usd" numeric(12, 6) NOT NULL,
	"cached_input_per_mtok_usd" numeric(12, 6),
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"effective_to" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_pricing_effective_range" CHECK ("model_pricing"."effective_to" IS NULL OR "model_pricing"."effective_to" > "model_pricing"."effective_from")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"monthly_budget_usd" numeric(12, 2),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_budget_non_negative" CHECK ("projects"."monthly_budget_usd" IS NULL OR "projects"."monthly_budget_usd" >= 0)
);
--> statement-breakpoint
CREATE TABLE "usage_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"provider" "provider" NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cached_input_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(14, 6) NOT NULL,
	"request_id" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_events_tokens_non_negative" CHECK ("usage_events"."input_tokens" >= 0 AND "usage_events"."output_tokens" >= 0 AND "usage_events"."cached_input_tokens" >= 0)
);
--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "model_pricing_provider_model_from_idx" ON "model_pricing" USING btree ("provider","model","effective_from");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_slug_idx" ON "projects" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "usage_events_project_occurred_idx" ON "usage_events" USING btree ("project_id","occurred_at");--> statement-breakpoint
CREATE INDEX "usage_events_provider_model_idx" ON "usage_events" USING btree ("provider","model");--> statement-breakpoint
CREATE UNIQUE INDEX "usage_events_provider_request_idx" ON "usage_events" USING btree ("provider","request_id") WHERE "usage_events"."request_id" IS NOT NULL;