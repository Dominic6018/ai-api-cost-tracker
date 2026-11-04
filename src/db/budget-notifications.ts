import { eq } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import {
  configuredChannels,
  deliverAlert,
  alertPeriod,
  planBudgetAlerts,
  type AlertConfig,
  type BudgetAlert,
} from "@/lib/budget-notifications";
import { budgetNotifications, type AlertChannel } from "./schema";
import { getSpendOverview } from "./spend";

/** Any Drizzle Postgres database, so callers and tests can pass their own. */
type Database = Pick<
  PgDatabase<PgQueryResultHKT>,
  "select" | "insert" | "delete"
>;

export type AlertOutcome =
  /** Delivered and recorded. */
  | "sent"
  /** This threshold, or a higher one, was already sent this month. */
  | "already_sent"
  /** Delivery failed; nothing is recorded, so the next run retries. */
  | "failed"
  /** `dryRun`: would have been sent. */
  | "would_send";

export interface AlertResult {
  alert: BudgetAlert;
  channel: AlertChannel;
  outcome: AlertOutcome;
  error?: string;
}

export interface RunBudgetAlertsOptions {
  config: AlertConfig;
  now?: Date;
  fetch?: typeof fetch;
  /** Plan and report, but neither send nor record anything. */
  dryRun?: boolean;
}

/**
 * Checks this month's spend against every budget and notifies each
 * configured channel once per project and threshold. Meant to be run on
 * a schedule; running it again sends nothing new.
 *
 * Each notification is claimed with a unique row before it's sent, so
 * overlapping runs don't both send it, and the claim is removed if
 * delivery fails, so the next run retries. One failure doesn't stop the
 * other channels or projects.
 */
export async function runBudgetAlerts(
  db: Database,
  options: RunBudgetAlertsOptions,
): Promise<AlertResult[]> {
  const now = options.now ?? new Date();
  const channels = configuredChannels(options.config);
  if (channels.length === 0) return [];

  const overview = await getSpendOverview(db, now);
  const alerts = planBudgetAlerts(overview.projects, now);
  if (alerts.length === 0) return [];

  const period = alertPeriod(now);
  const sent = await db
    .select({
      projectId: budgetNotifications.projectId,
      thresholdPercent: budgetNotifications.thresholdPercent,
      channel: budgetNotifications.channel,
    })
    .from(budgetNotifications)
    .where(eq(budgetNotifications.period, period));
  // Once "over budget" was sent, an 80% message would be news to no one.
  const alreadySent = (alert: BudgetAlert, channel: AlertChannel) =>
    sent.some(
      (row) =>
        row.projectId === alert.project.id &&
        row.channel === channel &&
        row.thresholdPercent >= alert.thresholdPercent,
    );

  const results: AlertResult[] = [];
  for (const alert of alerts) {
    for (const channel of channels) {
      if (alreadySent(alert, channel)) {
        results.push({ alert, channel, outcome: "already_sent" });
        continue;
      }
      if (options.dryRun) {
        results.push({ alert, channel, outcome: "would_send" });
        continue;
      }

      const [claim] = await db
        .insert(budgetNotifications)
        .values({
          projectId: alert.project.id,
          period: alert.period,
          thresholdPercent: alert.thresholdPercent,
          channel,
          spentUsd: alert.spentUsd,
          budgetUsd: alert.budgetUsd,
        })
        .onConflictDoNothing()
        .returning({ id: budgetNotifications.id });
      if (!claim) {
        // Another run claimed it after this one looked.
        results.push({ alert, channel, outcome: "already_sent" });
        continue;
      }

      const delivery = await deliverAlert(alert, channel, options.config, {
        fetch: options.fetch,
        now,
      });
      if (delivery.ok) {
        results.push({ alert, channel, outcome: "sent" });
      } else {
        await db
          .delete(budgetNotifications)
          .where(eq(budgetNotifications.id, claim.id));
        results.push({
          alert,
          channel,
          outcome: "failed",
          error: delivery.error,
        });
      }
    }
  }
  return results;
}
