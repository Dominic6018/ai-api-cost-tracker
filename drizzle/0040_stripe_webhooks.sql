CREATE TABLE "billing_stripe_invoice_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"stripe_event_id" text NOT NULL,
	"status" text NOT NULL,
	"amount_paid_cents" bigint,
	"occurred_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_stripe_invoice_events_status_valid" CHECK ("billing_stripe_invoice_events"."status" in ('open', 'paid', 'payment_failed', 'void', 'uncollectible')),
	CONSTRAINT "billing_stripe_invoice_events_paid_valid" CHECK ("billing_stripe_invoice_events"."amount_paid_cents" is null or "billing_stripe_invoice_events"."amount_paid_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "stripe_webhook_events" (
	"event_id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"livemode" boolean NOT NULL,
	"outcome" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stripe_webhook_events_outcome_valid" CHECK ("stripe_webhook_events"."outcome" in ('recorded', 'ignored'))
);
--> statement-breakpoint
ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_action_valid";--> statement-breakpoint
ALTER TABLE "billing_ledger_entries" DROP CONSTRAINT "billing_ledger_entries_kind_valid";--> statement-breakpoint
ALTER TABLE "billing_ledger_entries" DROP CONSTRAINT "billing_ledger_entries_credit_valid";--> statement-breakpoint
ALTER TABLE "billing_stripe_invoice_events" ADD CONSTRAINT "billing_stripe_invoice_events_invoice_id_billing_stripe_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."billing_stripe_invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "billing_stripe_invoice_events_event_idx" ON "billing_stripe_invoice_events" USING btree ("stripe_event_id");--> statement-breakpoint
CREATE INDEX "billing_stripe_invoice_events_invoice_idx" ON "billing_stripe_invoice_events" USING btree ("invoice_id","occurred_at");--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_action_valid" CHECK ("audit_log"."action" in ('project.created', 'project.updated', 'price.added', 'price.ended', 'account.created', 'account.role_changed', 'account.password_reset', 'account.sessions_revoked', 'api_key.created', 'api_key.revoked', 'organization.created', 'account.organization_changed', 'usage.repriced', 'billing.customer_created', 'billing.adjusted', 'billing.reversed', 'billing.plan_created', 'billing.subscribed', 'billing.unsubscribed', 'billing.charged', 'billing.credit_granted', 'billing.credits_applied', 'billing.credit_refunded', 'billing.stripe_invoiced', 'billing.stripe_paid'));--> statement-breakpoint
ALTER TABLE "billing_ledger_entries" ADD CONSTRAINT "billing_ledger_entries_kind_valid" CHECK ("billing_ledger_entries"."kind" in ('adjustment', 'reversal', 'plan_fee', 'usage_charge', 'credit_applied', 'payment'));--> statement-breakpoint
ALTER TABLE "billing_ledger_entries" ADD CONSTRAINT "billing_ledger_entries_credit_valid" CHECK ("billing_ledger_entries"."kind" not in ('credit_applied', 'payment') or "billing_ledger_entries"."amount_usd" < 0);--> statement-breakpoint
-- An invoice's history in Stripe is a record: append-only.
CREATE TRIGGER "billing_stripe_invoice_events_append_only" BEFORE UPDATE OR DELETE ON "billing_stripe_invoice_events" FOR EACH ROW EXECUTE FUNCTION "billing_append_only"();--> statement-breakpoint
CREATE TRIGGER "billing_stripe_invoice_events_no_truncate" BEFORE TRUNCATE ON "billing_stripe_invoice_events" FOR EACH STATEMENT EXECUTE FUNCTION "billing_append_only"();
