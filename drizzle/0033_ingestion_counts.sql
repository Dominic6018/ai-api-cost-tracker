CREATE TABLE "ingestion_counts" (
	"project_id" uuid NOT NULL,
	"day" date NOT NULL,
	"outcome" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "ingestion_counts_outcome_valid" CHECK ("ingestion_counts"."outcome" in ('stored', 'unpriced', 'replayed', 'conflict', 'invalid')),
	CONSTRAINT "ingestion_counts_count_valid" CHECK ("ingestion_counts"."count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "ingestion_counts" ADD CONSTRAINT "ingestion_counts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ingestion_counts_project_day_outcome_idx" ON "ingestion_counts" USING btree ("project_id","day","outcome");--> statement-breakpoint
CREATE INDEX "ingestion_counts_day_idx" ON "ingestion_counts" USING btree ("day");