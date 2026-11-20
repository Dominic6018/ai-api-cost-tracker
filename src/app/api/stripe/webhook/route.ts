import { db } from "@/db";
import { recordStripeEvent } from "@/db/stripe-webhooks";
import { createStripeWebhookHandler } from "./handler";

export const POST = createStripeWebhookHandler({
  // Read per request, so setting it needs no code change.
  secret: () => process.env.STRIPE_WEBHOOK_SECRET,
  record: (event, invoice) => recordStripeEvent(db, event, invoice),
});
