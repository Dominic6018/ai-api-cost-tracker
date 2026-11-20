CREATE TABLE "billing_portal_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_viewed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_action_valid";--> statement-breakpoint
ALTER TABLE "billing_portal_links" ADD CONSTRAINT "billing_portal_links_customer_fk" FOREIGN KEY ("customer_id","organization_id") REFERENCES "public"."billing_customers"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "billing_portal_links_token_hash_idx" ON "billing_portal_links" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "billing_portal_links_customer_idx" ON "billing_portal_links" USING btree ("customer_id");--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_action_valid" CHECK ("audit_log"."action" in ('project.created', 'project.updated', 'price.added', 'price.ended', 'account.created', 'account.role_changed', 'account.password_reset', 'account.sessions_revoked', 'api_key.created', 'api_key.revoked', 'organization.created', 'account.organization_changed', 'usage.repriced', 'billing.customer_created', 'billing.adjusted', 'billing.reversed', 'billing.plan_created', 'billing.subscribed', 'billing.unsubscribed', 'billing.charged', 'billing.credit_granted', 'billing.credits_applied', 'billing.credit_refunded', 'billing.stripe_invoiced', 'billing.stripe_paid', 'account.invited', 'account.invitation_revoked', 'billing.portal_link_created', 'billing.portal_link_revoked'));