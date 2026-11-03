CREATE TABLE "outcomes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"count" integer DEFAULT 1 NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"outcome_id" text,
	"customer_id" text,
	"user_id" text,
	"feature" text,
	"run_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outcomes_count_positive" CHECK ("outcomes"."count" > 0)
);
--> statement-breakpoint
ALTER TABLE "outcomes" ADD CONSTRAINT "outcomes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "outcomes_project_name_occurred_idx" ON "outcomes" USING btree ("project_id","name","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "outcomes_project_outcome_id_idx" ON "outcomes" USING btree ("project_id","outcome_id");