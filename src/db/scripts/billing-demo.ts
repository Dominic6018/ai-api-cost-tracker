import "dotenv/config";
import { parseArgs } from "node:util";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { monthLabel } from "@/lib/billing";
import { parseEnv } from "@/lib/env";
import { absoluteUrl } from "@/lib/links";
import { formatStatementUsd, portalPath } from "@/lib/portal";
import { formatShare } from "@/lib/revenue";
import {
  BILLING_DEMO_SLUG,
  removeBillingDemo,
  runBillingDemo,
} from "../demo/billing";

const USAGE = `Usage:
  npm run db:demo-billing [-- --url <app URL>]   Bill last month for three demo customers
  npm run db:demo-billing -- --remove           Remove the demo organization

Runs usage-based billing end to end in its own organization, "${BILLING_DEMO_SLUG}":
two plans, three customers on them since the start of last month, their AI
usage, prepaid credit, last month's charges, credit applied, revenue against
AI API cost, and a customer portal link. Running it again starts over. It
needs the seed prices (npm run db:seed). --allow-production is required when
NODE_ENV is production.`;

// Runs the billing demo in the database in DATABASE_URL.
async function main() {
  const { values } = parseArgs({
    options: {
      remove: { type: "boolean", default: false },
      url: { type: "string" },
      "allow-production": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  const env = parseEnv();
  if (env.NODE_ENV === "production" && !values["allow-production"]) {
    throw new Error(
      "Refusing to touch demo data: NODE_ENV is production. Pass --allow-production for a demo deployment.",
    );
  }
  const appUrl = values.url ? new URL(values.url) : null;

  const client = postgres(env.DATABASE_URL, { max: 1, onnotice: () => {} });
  const db = drizzle(client);
  try {
    if (values.remove) {
      const removed = await removeBillingDemo(db);
      console.log(
        removed
          ? `Removed the ${BILLING_DEMO_SLUG} organization and everything in it.`
          : `No ${BILLING_DEMO_SLUG} organization to remove.`,
      );
      return;
    }

    const result = await runBillingDemo(db);
    const usd = formatStatementUsd;
    console.log(
      `Billed ${monthLabel(result.month)} for the ${BILLING_DEMO_SLUG} organization\n`,
    );
    for (const c of result.customers) {
      console.log(
        `${c.externalId.padEnd(15)} ${c.plan.padEnd(8)} ${String(c.requests).padStart(3)} requests  ` +
          `AI API cost ${usd(c.aiCostMicros)}`,
      );
      console.log(
        `${"".padEnd(15)} fee ${usd(c.charges.feeMicros)} + usage ${usd(c.charges.billableUsageMicros)} ` +
          `(${usd(c.charges.usageChargeMicros)} less ${usd(c.charges.includedMicros)} included)` +
          (c.creditAppliedMicros > 0n
            ? ` - credit ${usd(c.creditAppliedMicros)}`
            : "") +
          ` = owes ${usd(c.balanceMicros)}`,
      );
    }
    const { total } = result.revenue;
    console.log(
      `\nRevenue ${usd(total.revenueMicros)}, AI API cost ${usd(total.costMicros)}, ` +
        `revenue minus AI API cost ${usd(total.differenceMicros)} (${formatShare(total.sharePermille)} of revenue)`,
    );
    const path = portalPath(result.portal.token);
    console.log(
      `\nPortal for ${result.portal.externalId} (send only to them; shown once):\n` +
        (appUrl
          ? absoluteUrl(path, {
              host: appUrl.host,
              proto: appUrl.protocol.replace(":", ""),
            })
          : path),
    );
    console.log(
      `\nSee it on the dashboard as an admin of the organization:\n` +
        `  npm run user -- create --email you@example.com --org ${BILLING_DEMO_SLUG}\n` +
        `then open /revenue (last month) and Customers → Portal links.\n` +
        `Remove it with: npm run db:demo-billing -- --remove`,
    );
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
