CREATE TABLE "budget_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"reservation_key" text NOT NULL,
	"run_id" text,
	"amount_usd" numeric(14, 6) NOT NULL,
	"status" text DEFAULT 'held' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "budget_reservations_status_valid" CHECK ("budget_reservations"."status" in ('held', 'released', 'settled')),
	CONSTRAINT "budget_reservations_amount_valid" CHECK ("budget_reservations"."amount_usd" >= 0),
	CONSTRAINT "budget_reservations_ended_valid" CHECK (("budget_reservations"."status" = 'held') = ("budget_reservations"."ended_at" is null))
);
--> statement-breakpoint
ALTER TABLE "budget_reservations" ADD CONSTRAINT "budget_reservations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "budget_reservations_project_key_idx" ON "budget_reservations" USING btree ("project_id","reservation_key");--> statement-breakpoint
CREATE INDEX "budget_reservations_held_idx" ON "budget_reservations" USING btree ("project_id","expires_at") WHERE "budget_reservations"."status" = 'held';