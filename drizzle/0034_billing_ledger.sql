CREATE TABLE "billing_customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_customers_external_id_valid" CHECK (char_length("billing_customers"."external_id") between 1 and 200),
	CONSTRAINT "billing_customers_name_valid" CHECK (char_length("billing_customers"."name") between 1 and 200)
);
--> statement-breakpoint
CREATE TABLE "billing_ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"amount_usd" numeric(14, 6) NOT NULL,
	"description" text NOT NULL,
	"entry_key" text,
	"reverses_entry_id" uuid,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_ledger_entries_kind_valid" CHECK ("billing_ledger_entries"."kind" in ('adjustment', 'reversal')),
	CONSTRAINT "billing_ledger_entries_amount_valid" CHECK ("billing_ledger_entries"."amount_usd" <> 0),
	CONSTRAINT "billing_ledger_entries_description_valid" CHECK (char_length("billing_ledger_entries"."description") between 1 and 500),
	CONSTRAINT "billing_ledger_entries_entry_key_valid" CHECK ("billing_ledger_entries"."entry_key" is null or char_length("billing_ledger_entries"."entry_key") between 1 and 200),
	CONSTRAINT "billing_ledger_entries_reversal_valid" CHECK (("billing_ledger_entries"."kind" = 'reversal') = ("billing_ledger_entries"."reverses_entry_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_action_valid";--> statement-breakpoint
ALTER TABLE "billing_customers" ADD CONSTRAINT "billing_customers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_ledger_entries" ADD CONSTRAINT "billing_ledger_entries_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_ledger_entries" ADD CONSTRAINT "billing_ledger_entries_customer_fk" FOREIGN KEY ("customer_id","organization_id") REFERENCES "public"."billing_customers"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_ledger_entries" ADD CONSTRAINT "billing_ledger_entries_reverses_fk" FOREIGN KEY ("reverses_entry_id") REFERENCES "public"."billing_ledger_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "billing_customers_organization_external_idx" ON "billing_customers" USING btree ("organization_id","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_customers_id_organization_idx" ON "billing_customers" USING btree ("id","organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_ledger_entries_key_idx" ON "billing_ledger_entries" USING btree ("organization_id","entry_key") WHERE "billing_ledger_entries"."entry_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "billing_ledger_entries_reverses_idx" ON "billing_ledger_entries" USING btree ("reverses_entry_id") WHERE "billing_ledger_entries"."reverses_entry_id" is not null;--> statement-breakpoint
CREATE INDEX "billing_ledger_entries_customer_idx" ON "billing_ledger_entries" USING btree ("customer_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_action_valid" CHECK ("audit_log"."action" in ('project.created', 'project.updated', 'price.added', 'price.ended', 'account.created', 'account.role_changed', 'account.password_reset', 'account.sessions_revoked', 'api_key.created', 'api_key.revoked', 'organization.created', 'account.organization_changed', 'usage.repriced', 'billing.customer_created', 'billing.adjusted', 'billing.reversed'));--> statement-breakpoint
-- The ledger is append-only: a correction is a reversing entry. Deletes
-- cascading from a deleted organization (nested, so depth > 1) are allowed.
CREATE FUNCTION "billing_ledger_entries_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'billing_ledger_entries is append-only; add a reversing entry instead'
    USING ERRCODE = 'restrict_violation';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "billing_ledger_entries_append_only" BEFORE UPDATE OR DELETE ON "billing_ledger_entries" FOR EACH ROW EXECUTE FUNCTION "billing_ledger_entries_append_only"();--> statement-breakpoint
CREATE TRIGGER "billing_ledger_entries_no_truncate" BEFORE TRUNCATE ON "billing_ledger_entries" FOR EACH STATEMENT EXECUTE FUNCTION "billing_ledger_entries_append_only"();
