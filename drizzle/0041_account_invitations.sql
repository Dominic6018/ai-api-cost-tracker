CREATE TABLE "account_invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"token_hash" text NOT NULL,
	"invited_by" uuid,
	"invited_by_label" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_user_id" uuid,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "account_invitations_role_valid" CHECK ("account_invitations"."role" in ('admin', 'member', 'viewer')),
	CONSTRAINT "account_invitations_closed_once" CHECK ("account_invitations"."accepted_at" is null or "account_invitations"."revoked_at" is null)
);
--> statement-breakpoint
ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_action_valid";--> statement-breakpoint
ALTER TABLE "account_invitations" ADD CONSTRAINT "account_invitations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_invitations" ADD CONSTRAINT "account_invitations_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_invitations" ADD CONSTRAINT "account_invitations_accepted_user_id_users_id_fk" FOREIGN KEY ("accepted_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "account_invitations_token_hash_idx" ON "account_invitations" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "account_invitations_pending_email_idx" ON "account_invitations" USING btree ("email") WHERE "account_invitations"."accepted_at" is null and "account_invitations"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "account_invitations_organization_idx" ON "account_invitations" USING btree ("organization_id");--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_action_valid" CHECK ("audit_log"."action" in ('project.created', 'project.updated', 'price.added', 'price.ended', 'account.created', 'account.role_changed', 'account.password_reset', 'account.sessions_revoked', 'api_key.created', 'api_key.revoked', 'organization.created', 'account.organization_changed', 'usage.repriced', 'billing.customer_created', 'billing.adjusted', 'billing.reversed', 'billing.plan_created', 'billing.subscribed', 'billing.unsubscribed', 'billing.charged', 'billing.credit_granted', 'billing.credits_applied', 'billing.credit_refunded', 'billing.stripe_invoiced', 'billing.stripe_paid', 'account.invited', 'account.invitation_revoked'));