import { db } from "@/db";
import { recordUsage } from "@/db/usage";
import { createUsageHandler } from "./handler";

export const POST = createUsageHandler({
  recordUsage: (usage) => recordUsage(db, usage),
  // Unauthenticated until per-project API keys land (#5).
  enabled: process.env.NODE_ENV !== "production",
});
