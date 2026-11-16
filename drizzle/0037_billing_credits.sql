CREATE TABLE "billing_credit_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"amount_usd" numeric(14, 6) NOT NULL,
	"expires_at" timestamp with time zone,
	"description" text NOT NULL,
	"grant_key" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_credit_grants_amount_valid" CHECK ("billing_credit_grants"."amount_usd" > 0),
	CONSTRAINT "billing_credit_grants_description_valid" CHECK (char_length("billing_credit_grants"."description") between 1 and 500),
	CONSTRAINT "billing_credit_grants_expiry_valid" CHECK ("billing_credit_grants"."expires_at" is null or "billing_credit_grants"."expires_at" > "billing_credit_grants"."created_at")
);
--> statement-breakpoint
CREATE TABLE "billing_credit_uses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"amount_usd" numeric(14, 6) NOT NULL,
	"ledger_entry_id" uuid,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_credit_uses_kind_valid" CHECK ("billing_credit_uses"."kind" in ('applied', 'refunded')),
	CONSTRAINT "billing_credit_uses_amount_valid" CHECK ("billing_credit_uses"."amount_usd" > 0),
	CONSTRAINT "billing_credit_uses_entry_valid" CHECK (("billing_credit_uses"."kind" = 'applied') = ("billing_credit_uses"."ledger_entry_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_action_valid";--> statement-breakpoint
ALTER TABLE "billing_ledger_entries" DROP CONSTRAINT "billing_ledger_entries_kind_valid";--> statement-breakpoint
CREATE UNIQUE INDEX "billing_credit_grants_owner_idx" ON "billing_credit_grants" USING btree ("id","customer_id","organization_id");--> statement-breakpoint
ALTER TABLE "billing_credit_grants" ADD CONSTRAINT "billing_credit_grants_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_credit_grants" ADD CONSTRAINT "billing_credit_grants_customer_fk" FOREIGN KEY ("customer_id","organization_id") REFERENCES "public"."billing_customers"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_credit_uses" ADD CONSTRAINT "billing_credit_uses_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_credit_uses" ADD CONSTRAINT "billing_credit_uses_ledger_entry_id_billing_ledger_entries_id_fk" FOREIGN KEY ("ledger_entry_id") REFERENCES "public"."billing_ledger_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_credit_uses" ADD CONSTRAINT "billing_credit_uses_grant_fk" FOREIGN KEY ("grant_id","customer_id","organization_id") REFERENCES "public"."billing_credit_grants"("id","customer_id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "billing_credit_grants_key_idx" ON "billing_credit_grants" USING btree ("organization_id","grant_key") WHERE "billing_credit_grants"."grant_key" is not null;--> statement-breakpoint
CREATE INDEX "billing_credit_grants_customer_idx" ON "billing_credit_grants" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "billing_credit_uses_grant_idx" ON "billing_credit_uses" USING btree ("grant_id");--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_action_valid" CHECK ("audit_log"."action" in ('project.created', 'project.updated', 'price.added', 'price.ended', 'account.created', 'account.role_changed', 'account.password_reset', 'account.sessions_revoked', 'api_key.created', 'api_key.revoked', 'organization.created', 'account.organization_changed', 'usage.repriced', 'billing.customer_created', 'billing.adjusted', 'billing.reversed', 'billing.plan_created', 'billing.subscribed', 'billing.unsubscribed', 'billing.charged', 'billing.credit_granted', 'billing.credits_applied', 'billing.credit_refunded'));--> statement-breakpoint
ALTER TABLE "billing_ledger_entries" ADD CONSTRAINT "billing_ledger_entries_credit_valid" CHECK ("billing_ledger_entries"."kind" <> 'credit_applied' or "billing_ledger_entries"."amount_usd" < 0);--> statement-breakpoint
ALTER TABLE "billing_ledger_entries" ADD CONSTRAINT "billing_ledger_entries_kind_valid" CHECK ("billing_ledger_entries"."kind" in ('adjustment', 'reversal', 'plan_fee', 'usage_charge', 'credit_applied'));--> statement-breakpoint
-- Grants and uses are append-only, like the ledger. Deletes cascading from
-- a deleted organization (nested, so depth > 1) are allowed.
CREATE FUNCTION "billing_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "billing_credit_grants_append_only" BEFORE UPDATE OR DELETE ON "billing_credit_grants" FOR EACH ROW EXECUTE FUNCTION "billing_append_only"();--> statement-breakpoint
CREATE TRIGGER "billing_credit_grants_no_truncate" BEFORE TRUNCATE ON "billing_credit_grants" FOR EACH STATEMENT EXECUTE FUNCTION "billing_append_only"();--> statement-breakpoint
CREATE TRIGGER "billing_credit_uses_append_only" BEFORE UPDATE OR DELETE ON "billing_credit_uses" FOR EACH ROW EXECUTE FUNCTION "billing_append_only"();--> statement-breakpoint
CREATE TRIGGER "billing_credit_uses_no_truncate" BEFORE TRUNCATE ON "billing_credit_uses" FOR EACH STATEMENT EXECUTE FUNCTION "billing_append_only"();--> statement-breakpoint
-- A use can't take more than is left of its grant, or use a grant that has
-- expired. The grant row is locked, so concurrent uses are checked in turn.
CREATE FUNCTION "billing_credit_uses_within_grant"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  granted numeric;
  expires timestamptz;
  used numeric;
BEGIN
  SELECT amount_usd, expires_at INTO granted, expires
    FROM billing_credit_grants WHERE id = NEW.grant_id FOR UPDATE;
  IF expires IS NOT NULL AND expires <= greatest(now(), NEW.created_at) THEN
    RAISE EXCEPTION 'credit grant % has expired', NEW.grant_id
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT coalesce(sum(amount_usd), 0) INTO used
    FROM billing_credit_uses WHERE grant_id = NEW.grant_id;
  IF used + NEW.amount_usd > granted THEN
    RAISE EXCEPTION 'credit grant % has only % left', NEW.grant_id, granted - used
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "billing_credit_uses_within_grant" BEFORE INSERT ON "billing_credit_uses" FOR EACH ROW EXECUTE FUNCTION "billing_credit_uses_within_grant"();
