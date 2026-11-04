CREATE TABLE "budget_notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"period" text NOT NULL,
	"threshold_percent" integer NOT NULL,
	"channel" text NOT NULL,
	"spent_usd" numeric(14, 6) NOT NULL,
	"budget_usd" numeric(12, 2) NOT NULL,
	"notified_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "budget_notifications_period_valid" CHECK ("budget_notifications"."period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "budget_notifications_threshold_valid" CHECK ("budget_notifications"."threshold_percent" in (80, 100)),
	CONSTRAINT "budget_notifications_channel_valid" CHECK ("budget_notifications"."channel" in ('webhook', 'slack'))
);
--> statement-breakpoint
ALTER TABLE "budget_notifications" ADD CONSTRAINT "budget_notifications_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "budget_notifications_once_idx" ON "budget_notifications" USING btree ("project_id","period","threshold_percent","channel");