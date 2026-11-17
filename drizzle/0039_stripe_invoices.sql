CREATE TABLE "billing_stripe_customers" (
	"customer_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"stripe_customer_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_stripe_customers_mode_valid" CHECK ("billing_stripe_customers"."mode" in ('test', 'live'))
);
--> statement-breakpoint
CREATE TABLE "billing_stripe_invoice_items" (
	"ledger_entry_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"invoice_id" uuid NOT NULL,
	"stripe_item_id" text,
	"amount_cents" bigint NOT NULL,
	CONSTRAINT "billing_stripe_invoice_items_mode_valid" CHECK ("billing_stripe_invoice_items"."mode" in ('test', 'live'))
);
--> statement-breakpoint
CREATE TABLE "billing_stripe_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"stripe_invoice_id" text NOT NULL,
	"amount_cents" bigint NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_stripe_invoices_mode_valid" CHECK ("billing_stripe_invoices"."mode" in ('test', 'live')),
	CONSTRAINT "billing_stripe_invoices_amount_valid" CHECK ("billing_stripe_invoices"."amount_cents" > 0)
);
--> statement-breakpoint
ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_action_valid";--> statement-breakpoint
ALTER TABLE "billing_stripe_customers" ADD CONSTRAINT "billing_stripe_customers_customer_id_billing_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."billing_customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_stripe_invoice_items" ADD CONSTRAINT "billing_stripe_invoice_items_ledger_entry_id_billing_ledger_entries_id_fk" FOREIGN KEY ("ledger_entry_id") REFERENCES "public"."billing_ledger_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_stripe_invoice_items" ADD CONSTRAINT "billing_stripe_invoice_items_invoice_id_billing_stripe_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."billing_stripe_invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_stripe_invoices" ADD CONSTRAINT "billing_stripe_invoices_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_stripe_invoices" ADD CONSTRAINT "billing_stripe_invoices_customer_fk" FOREIGN KEY ("customer_id","organization_id") REFERENCES "public"."billing_customers"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "billing_stripe_customers_customer_idx" ON "billing_stripe_customers" USING btree ("customer_id","mode");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_stripe_invoice_items_entry_idx" ON "billing_stripe_invoice_items" USING btree ("ledger_entry_id","mode");--> statement-breakpoint
CREATE INDEX "billing_stripe_invoice_items_invoice_idx" ON "billing_stripe_invoice_items" USING btree ("invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_stripe_invoices_stripe_idx" ON "billing_stripe_invoices" USING btree ("stripe_invoice_id");--> statement-breakpoint
CREATE INDEX "billing_stripe_invoices_customer_idx" ON "billing_stripe_invoices" USING btree ("customer_id");--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_action_valid" CHECK ("audit_log"."action" in ('project.created', 'project.updated', 'price.added', 'price.ended', 'account.created', 'account.role_changed', 'account.password_reset', 'account.sessions_revoked', 'api_key.created', 'api_key.revoked', 'organization.created', 'account.organization_changed', 'usage.repriced', 'billing.customer_created', 'billing.adjusted', 'billing.reversed', 'billing.plan_created', 'billing.subscribed', 'billing.unsubscribed', 'billing.charged', 'billing.credit_granted', 'billing.credits_applied', 'billing.credit_refunded', 'billing.stripe_invoiced'));
--> statement-breakpoint
-- What was sent to Stripe is a record, like the ledger: append-only.
CREATE TRIGGER "billing_stripe_invoices_append_only" BEFORE UPDATE OR DELETE ON "billing_stripe_invoices" FOR EACH ROW EXECUTE FUNCTION "billing_append_only"();--> statement-breakpoint
CREATE TRIGGER "billing_stripe_invoices_no_truncate" BEFORE TRUNCATE ON "billing_stripe_invoices" FOR EACH STATEMENT EXECUTE FUNCTION "billing_append_only"();--> statement-breakpoint
CREATE TRIGGER "billing_stripe_invoice_items_append_only" BEFORE UPDATE OR DELETE ON "billing_stripe_invoice_items" FOR EACH ROW EXECUTE FUNCTION "billing_append_only"();--> statement-breakpoint
CREATE TRIGGER "billing_stripe_invoice_items_no_truncate" BEFORE TRUNCATE ON "billing_stripe_invoice_items" FOR EACH STATEMENT EXECUTE FUNCTION "billing_append_only"();
