CREATE TABLE "billing_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"monthly_fee_usd" numeric(14, 6) NOT NULL,
	"included_usage_usd" numeric(14, 6) NOT NULL,
	"usage_multiplier" numeric(10, 4) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_plans_name_valid" CHECK (char_length("billing_plans"."name") between 1 and 200),
	CONSTRAINT "billing_plans_amounts_valid" CHECK ("billing_plans"."monthly_fee_usd" >= 0 and "billing_plans"."included_usage_usd" >= 0 and "billing_plans"."usage_multiplier" >= 0)
);
--> statement-breakpoint
CREATE TABLE "billing_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_subscriptions_months_valid" CHECK (extract(day from "billing_subscriptions"."starts_on") = 1 and ("billing_subscriptions"."ends_on" is null or (extract(day from "billing_subscriptions"."ends_on") = 1 and "billing_subscriptions"."ends_on" > "billing_subscriptions"."starts_on")))
);
--> statement-breakpoint
ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_action_valid";--> statement-breakpoint
CREATE UNIQUE INDEX "billing_plans_id_organization_idx" ON "billing_plans" USING btree ("id","organization_id");--> statement-breakpoint
ALTER TABLE "billing_plans" ADD CONSTRAINT "billing_plans_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD CONSTRAINT "billing_subscriptions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD CONSTRAINT "billing_subscriptions_customer_fk" FOREIGN KEY ("customer_id","organization_id") REFERENCES "public"."billing_customers"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD CONSTRAINT "billing_subscriptions_plan_fk" FOREIGN KEY ("plan_id","organization_id") REFERENCES "public"."billing_plans"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "billing_plans_organization_slug_idx" ON "billing_plans" USING btree ("organization_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_subscriptions_open_idx" ON "billing_subscriptions" USING btree ("customer_id") WHERE "billing_subscriptions"."ends_on" is null;--> statement-breakpoint
CREATE INDEX "billing_subscriptions_customer_idx" ON "billing_subscriptions" USING btree ("customer_id","starts_on");--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_action_valid" CHECK ("audit_log"."action" in ('project.created', 'project.updated', 'price.added', 'price.ended', 'account.created', 'account.role_changed', 'account.password_reset', 'account.sessions_revoked', 'api_key.created', 'api_key.revoked', 'organization.created', 'account.organization_changed', 'usage.repriced', 'billing.customer_created', 'billing.adjusted', 'billing.reversed', 'billing.plan_created', 'billing.subscribed', 'billing.unsubscribed'));