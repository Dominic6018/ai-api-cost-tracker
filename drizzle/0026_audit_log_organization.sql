DROP INDEX "audit_log_occurred_at_idx";--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "organization_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_organization_occurred_idx" ON "audit_log" USING btree ("organization_id","occurred_at" DESC NULLS LAST,"id" DESC NULLS LAST);