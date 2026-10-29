import { db } from "@/db";
import { authenticateApiKey } from "@/db/api-keys";
import { recordUsage } from "@/db/usage";
import { createUsageHandler } from "./handler";

export const POST = createUsageHandler({
  authenticate: (apiKey) => authenticateApiKey(db, apiKey),
  recordUsage: (usage) => recordUsage(db, usage),
});
