import "dotenv/config";
import { parseArgs } from "node:util";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import {
  configuredChannels,
  parseAlertConfig,
} from "@/lib/budget-notifications";
import { BUDGET_THRESHOLDS } from "@/lib/budget";
import { parseEnv } from "@/lib/env";
import { runBudgetAlerts } from "../budget-notifications";

const USAGE = `Usage:
  npm run budget-alerts [-- --dry-run]

Checks this month's (UTC) spend against each project's monthly budget and
notifies when a project reaches 80% or 100% of it: once per project,
threshold and destination each month. Run it on a schedule, e.g. every
15 minutes from cron; running it again sends nothing new. It exits with
status 1 if a delivery failed, which the next run retries.

Options:
  --dry-run   Show what would be sent, without sending or recording it

Environment (at least one destination):
  BUDGET_ALERT_WEBHOOK_URL         POST a JSON event to this URL
  BUDGET_ALERT_WEBHOOK_SECRET      Sign it (HMAC-SHA256, 16+ characters)
  BUDGET_ALERT_SLACK_WEBHOOK_URL   A Slack incoming webhook URL`;

async function main() {
  const { values } = parseArgs({
    options: {
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  const config = parseAlertConfig(process.env);
  const channels = configuredChannels(config);
  if (channels.length === 0) {
    throw new Error(
      `Set BUDGET_ALERT_WEBHOOK_URL or BUDGET_ALERT_SLACK_WEBHOOK_URL.\n\n${USAGE}`,
    );
  }

  const client = postgres(parseEnv().DATABASE_URL, {
    max: 1,
    onnotice: () => {},
  });
  try {
    const results = await runBudgetAlerts(drizzle(client), {
      config,
      dryRun: values["dry-run"],
    });
    for (const { alert, channel, outcome, error } of results) {
      const used = alert.usedPercent ?? "over a zero budget";
      console.log(
        `${outcome.padEnd(12)} ${channel.padEnd(7)} ${alert.project.slug}: ${alert.thresholdPercent}% threshold, ${used} of $${alert.budgetUsd}${error ? ` (${error})` : ""}`,
      );
    }
    const failed = results.filter((r) => r.outcome === "failed").length;
    console.log(
      results.length === 0
        ? `No project is at ${BUDGET_THRESHOLDS.warningPercent}% of its budget this month.`
        : `${results.length} notification(s) checked, ${failed} failed.`,
    );
    if (failed > 0) process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
