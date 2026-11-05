CREATE TABLE "spend_signal_notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"period" text NOT NULL,
	"channel" text NOT NULL,
	"amount_usd" numeric(14, 6) NOT NULL,
	"reference_usd" numeric(14, 6) NOT NULL,
	"notified_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "spend_signal_notifications_period_valid" CHECK (("spend_signal_notifications"."kind" = 'forecast' and "spend_signal_notifications"."period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$') or ("spend_signal_notifications"."kind" = 'spike' and "spend_signal_notifications"."period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$')),
	CONSTRAINT "spend_signal_notifications_channel_valid" CHECK ("spend_signal_notifications"."channel" in ('webhook', 'slack'))
);
--> statement-breakpoint
ALTER TABLE "spend_signal_notifications" ADD CONSTRAINT "spend_signal_notifications_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "spend_signal_notifications_once_idx" ON "spend_signal_notifications" USING btree ("project_id","kind","period","channel");