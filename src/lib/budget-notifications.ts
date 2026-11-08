/**
 * Budget notifications: when a project reaches 80% or 100% of its monthly
 * budget, tell a webhook, Slack and/or email, once per threshold per month.
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
import {
  sendEmail,
  transportOptions,
  type EmailConfig,
  type EmailContent,
  type SendEmail,
} from "./email";

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

/** The addresses in a comma-separated list. */
const emailList = (value: string) => value.split(",").map((a) => a.trim());
const isEmailList = (value: string) =>
  emailList(value).every((a) => z.email().safeParse(a).success);

const isSmtpUrl = (value: string) => {
  try {
    transportOptions(value);
    return true;
  } catch {
    return false;
  }
};

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
  // The messages don't quote the value: the URL holds a password.
  BUDGET_ALERT_SMTP_URL: z
    .string()
    .refine(isSmtpUrl, {
      error:
        "BUDGET_ALERT_SMTP_URL must look like smtp(s)://user:password@host:port, with special characters percent-encoded",
    })
    .optional(),
  BUDGET_ALERT_EMAIL_FROM: z
    .email("BUDGET_ALERT_EMAIL_FROM must be an email address")
    .optional(),
  BUDGET_ALERT_EMAIL_TO: z
    .string()
    .refine(isEmailList, {
      error:
        "BUDGET_ALERT_EMAIL_TO must be one or more comma-separated email addresses",
    })
    .optional(),
});

export interface AlertConfig {
  webhook?: { url: string; secret?: string };
  slack?: { url: string };
  email?: EmailConfig;
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
  const emailSettings = [
    env.BUDGET_ALERT_SMTP_URL,
    env.BUDGET_ALERT_EMAIL_FROM,
    env.BUDGET_ALERT_EMAIL_TO,
  ].filter(Boolean).length;
  if (emailSettings !== 0 && emailSettings !== 3) {
    throw new Error(
      "Set BUDGET_ALERT_SMTP_URL, BUDGET_ALERT_EMAIL_FROM and BUDGET_ALERT_EMAIL_TO together",
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
    ...(env.BUDGET_ALERT_SMTP_URL &&
      env.BUDGET_ALERT_EMAIL_FROM &&
      env.BUDGET_ALERT_EMAIL_TO && {
        email: {
          smtpUrl: env.BUDGET_ALERT_SMTP_URL,
          from: env.BUDGET_ALERT_EMAIL_FROM,
          to: emailList(env.BUDGET_ALERT_EMAIL_TO),
        },
      }),
  };
}

export function configuredChannels(config: AlertConfig): AlertChannel[] {
  const channels: AlertChannel[] = [];
  if (config.webhook) channels.push("webhook");
  if (config.slack) channels.push("slack");
  if (config.email) channels.push("email");
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
/** An exact decimal amount in whole cents, e.g. "$1,234.50". */
export const usd = (amount: string) =>
  wholeCents.format(microsToUsd(toMicros(amount)));

/** Slack treats &, < and > as markup; anything else is shown as typed. */
export const slackEscape = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The alert as a sentence, with the name already formatted. */
function budgetSentence(alert: BudgetAlert, name: string): string {
  const budget = usd(alert.budgetUsd);
  const spent = usd(alert.spentUsd);
  const used = alert.usedPercent ? ` (${alert.usedPercent})` : "";
  return alert.status === "over"
    ? `${name} is over its ${budget} monthly budget for ${alert.period}: ${spent} spent${used}.`
    : `${name} has used ${alert.usedPercent} of its ${budget} monthly budget for ${alert.period}: ${spent} spent.`;
}

/** A Slack incoming-webhook body. */
export function slackPayload(alert: BudgetAlert) {
  const name = `*${slackEscape(alert.project.name)}*`;
  const icon = alert.status === "over" ? ":rotating_light:" : ":warning:";
  return { text: `${icon} ${budgetSentence(alert, name)}` };
}

/** A plain-text email; the subject is kept to one line. */
export function emailMessage(subject: string, sentence: string): EmailContent {
  return {
    subject: subject.replace(/\s+/g, " ").trim(),
    text: `${sentence}\n\nSent by AI API Cost Tracker.\n`,
  };
}

export function budgetEmail(alert: BudgetAlert): EmailContent {
  const { name } = alert.project;
  return emailMessage(
    alert.status === "over"
      ? `${name}: over budget for ${alert.period}`
      : `${name}: ${alert.usedPercent} of budget used for ${alert.period}`,
    budgetSentence(alert, name),
  );
}

export type DeliveryResult =
  | {
      ok: true;
      /** Delivered, but with something the operator should see. */
      note?: string;
    }
  | { ok: false; error: string };

export interface DeliveryOptions {
  fetch?: typeof fetch;
  now?: Date;
  sendEmail?: SendEmail;
}

/** Sends one alert to one channel. Never throws. */
export function deliverAlert(
  alert: BudgetAlert,
  channel: AlertChannel,
  config: AlertConfig,
  options: DeliveryOptions = {},
): Promise<DeliveryResult> {
  const now = options.now ?? new Date();
  return postToChannel(
    channel,
    config,
    {
      event: WEBHOOK_EVENT,
      webhookBody: webhookPayload(alert, now),
      slackBody: slackPayload(alert),
      email: budgetEmail(alert),
    },
    { ...options, now },
  );
}

/** What one notification sends on each channel. */
export interface ChannelMessage {
  event: string;
  webhookBody: object;
  slackBody: { text: string };
  email: EmailContent;
}

/**
 * Accepted by the server for at least one recipient counts as delivered:
 * retrying would send the others a duplicate on every run. Refused
 * recipients are reported instead.
 */
async function deliverEmail(
  config: EmailConfig,
  content: EmailContent,
  send: SendEmail,
): Promise<DeliveryResult> {
  try {
    const { rejected } = await send(config, content);
    return rejected.length > 0
      ? { ok: true, note: `refused recipients: ${rejected.join(", ")}` }
      : { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Sends a message to one channel. Webhook and Slack get a JSON POST,
 * signed for the webhook when a secret is set, with a timeout, and
 * without following redirects. Never throws.
 */
export async function postToChannel(
  channel: AlertChannel,
  config: AlertConfig,
  message: ChannelMessage,
  options: DeliveryOptions = {},
): Promise<DeliveryResult> {
  if (channel === "email") {
    return config.email
      ? deliverEmail(
          config.email,
          message.email,
          options.sendEmail ?? sendEmail,
        )
      : { ok: false, error: "email isn't configured" };
  }

  const fetchImpl = options.fetch ?? globalThis.fetch;
  const now = options.now ?? new Date();
  const destination = channel === "webhook" ? config.webhook : config.slack;
  if (!destination) return { ok: false, error: `${channel} isn't configured` };

  const body = JSON.stringify(
    channel === "webhook" ? message.webhookBody : message.slackBody,
  );
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (channel === "webhook") {
    headers["x-cost-tracker-event"] = message.event;
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
