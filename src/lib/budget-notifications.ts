/**
 * Budget notifications: when a project reaches 80% or 100% of its monthly
 * budget, tell a webhook and/or Slack, once per threshold per month.
 */

import { createHmac } from "node:crypto";
import { z } from "zod";
import type { AlertChannel } from "@/db/schema";
import {
  BUDGET_THRESHOLDS,
  budgetStatus,
  budgetUtilization,
  formatUsedPercent,
  microsToUsd,
  toMicros,
} from "./budget";

export type ThresholdPercent =
  | typeof BUDGET_THRESHOLDS.warningPercent
  | typeof BUDGET_THRESHOLDS.overPercent;

export const WEBHOOK_EVENT = "budget.threshold_reached";
export const SIGNATURE_HEADER = "x-cost-tracker-signature";
const DELIVERY_TIMEOUT_MS = 10_000;

const httpUrl = (name: string, httpsOnly = false) =>
  z
    .url({
      protocol: httpsOnly ? /^https$/ : /^https?$/,
      error: `${name} must be an ${httpsOnly ? "https" : "http(s)"} URL`,
    })
    .optional();

const configSchema = z.object({
  BUDGET_ALERT_WEBHOOK_URL: httpUrl("BUDGET_ALERT_WEBHOOK_URL"),
  BUDGET_ALERT_WEBHOOK_SECRET: z
    .string()
    .min(16, "BUDGET_ALERT_WEBHOOK_SECRET must be at least 16 characters")
    .optional(),
  // Slack only serves incoming webhooks over HTTPS.
  BUDGET_ALERT_SLACK_WEBHOOK_URL: httpUrl(
    "BUDGET_ALERT_SLACK_WEBHOOK_URL",
    true,
  ),
});

export interface AlertConfig {
  webhook?: { url: string; secret?: string };
  slack?: { url: string };
}

/**
 * Reads the destinations from the environment; empty values count as
 * unset. Throws a readable error for an invalid one.
 */
export function parseAlertConfig(
  source: Record<string, string | undefined>,
): AlertConfig {
  const trimmed = Object.fromEntries(
    Object.keys(configSchema.shape).map((key) => [
      key,
      source[key]?.trim() || undefined,
    ]),
  );
  const result = configSchema.safeParse(trimmed);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid budget alert configuration:\n${details}`);
  }
  const env = result.data;
  if (env.BUDGET_ALERT_WEBHOOK_SECRET && !env.BUDGET_ALERT_WEBHOOK_URL) {
    throw new Error(
      "BUDGET_ALERT_WEBHOOK_SECRET is set without BUDGET_ALERT_WEBHOOK_URL",
    );
  }
  return {
    ...(env.BUDGET_ALERT_WEBHOOK_URL && {
      webhook: {
        url: env.BUDGET_ALERT_WEBHOOK_URL,
        ...(env.BUDGET_ALERT_WEBHOOK_SECRET && {
          secret: env.BUDGET_ALERT_WEBHOOK_SECRET,
        }),
      },
    }),
    ...(env.BUDGET_ALERT_SLACK_WEBHOOK_URL && {
      slack: { url: env.BUDGET_ALERT_SLACK_WEBHOOK_URL },
    }),
  };
}

export function configuredChannels(config: AlertConfig): AlertChannel[] {
  const channels: AlertChannel[] = [];
  if (config.webhook) channels.push("webhook");
  if (config.slack) channels.push("slack");
  return channels;
}

/** The UTC month of `now`, e.g. "2026-11". */
export function alertPeriod(now: Date): string {
  return now.toISOString().slice(0, 7);
}

export interface BudgetAlert {
  project: { id: string; name: string; slug: string };
  /** The UTC month, e.g. "2026-11". */
  period: string;
  /** The highest threshold reached; only that one is announced. */
  thresholdPercent: ThresholdPercent;
  status: "warning" | "over";
  /** Exact decimal strings, as stored. */
  spentUsd: string;
  budgetUsd: string;
  /** e.g. "81.2%"; null for spend against a zero budget. */
  usedPercent: string | null;
}

/**
 * One alert per project at or above a threshold this month, at the
 * highest threshold reached, so a project that jumps straight past 100%
 * gets one "over budget" message rather than two.
 */
export function planBudgetAlerts(
  projects: Array<{
    id: string;
    name: string;
    slug: string;
    month: string;
    monthlyBudgetUsd: string | null;
  }>,
  now: Date,
): BudgetAlert[] {
  const period = alertPeriod(now);
  const alerts: BudgetAlert[] = [];
  for (const project of projects) {
    const utilization = budgetUtilization(
      project.month,
      project.monthlyBudgetUsd,
    );
    const status = budgetStatus(utilization);
    if (!utilization.hasBudget || (status !== "warning" && status !== "over")) {
      continue;
    }
    const usedPercent = formatUsedPercent(utilization);
    alerts.push({
      project: { id: project.id, name: project.name, slug: project.slug },
      period,
      thresholdPercent:
        status === "over"
          ? BUDGET_THRESHOLDS.overPercent
          : BUDGET_THRESHOLDS.warningPercent,
      status,
      spentUsd: project.month,
      budgetUsd: project.monthlyBudgetUsd as string,
      usedPercent: usedPercent === "—" ? null : usedPercent,
    });
  }
  return alerts;
}

/** The generic webhook's JSON body. */
export function webhookPayload(alert: BudgetAlert, sentAt: Date) {
  return {
    type: WEBHOOK_EVENT,
    project: alert.project,
    period: alert.period,
    thresholdPercent: alert.thresholdPercent,
    status: alert.status,
    spentUsd: alert.spentUsd,
    budgetUsd: alert.budgetUsd,
    usedPercent: alert.usedPercent,
    sentAt: sentAt.toISOString(),
  };
}

/**
 * `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">`. Signing the
 * timestamp lets a receiver reject old messages being replayed.
 */
export function signWebhook(body: string, secret: string, at: Date): string {
  const timestamp = Math.floor(at.getTime() / 1000);
  const mac = createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex");
  return `t=${timestamp},v1=${mac}`;
}

const wholeCents = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const usd = (amount: string) =>
  wholeCents.format(microsToUsd(toMicros(amount)));

/** Slack treats &, < and > as markup; anything else is shown as typed. */
const slackEscape = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A Slack incoming-webhook body. */
export function slackPayload(alert: BudgetAlert) {
  const name = `*${slackEscape(alert.project.name)}*`;
  const budget = usd(alert.budgetUsd);
  const spent = usd(alert.spentUsd);
  const used = alert.usedPercent ? ` (${alert.usedPercent})` : "";
  const text =
    alert.status === "over"
      ? `:rotating_light: ${name} is over its ${budget} monthly budget for ${alert.period}: ${spent} spent${used}.`
      : `:warning: ${name} has used ${alert.usedPercent} of its ${budget} monthly budget for ${alert.period}: ${spent} spent.`;
  return { text };
}

export type DeliveryResult = { ok: true } | { ok: false; error: string };

/** POSTs one alert to one channel. Never throws. */
export async function deliverAlert(
  alert: BudgetAlert,
  channel: AlertChannel,
  config: AlertConfig,
  options: { fetch?: typeof fetch; now?: Date } = {},
): Promise<DeliveryResult> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const now = options.now ?? new Date();
  const destination = channel === "webhook" ? config.webhook : config.slack;
  if (!destination) return { ok: false, error: `${channel} isn't configured` };

  const body = JSON.stringify(
    channel === "webhook" ? webhookPayload(alert, now) : slackPayload(alert),
  );
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (channel === "webhook") {
    headers["x-cost-tracker-event"] = WEBHOOK_EVENT;
    if (config.webhook?.secret) {
      headers[SIGNATURE_HEADER] = signWebhook(body, config.webhook.secret, now);
    }
  }
  try {
    const response = await fetchImpl(destination.url, {
      method: "POST",
      headers,
      body,
      // A redirect isn't a delivery; don't resend the body elsewhere.
      redirect: "manual",
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
    // Drain the body so the connection can be reused.
    await response.arrayBuffer().catch(() => undefined);
    return response.ok
      ? { ok: true }
      : { ok: false, error: `HTTP ${response.status}` };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
