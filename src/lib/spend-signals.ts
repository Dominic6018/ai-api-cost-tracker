/**
 * Notifications for the overview's two early warnings: a month-end
 * forecast over budget, and a spending spike today. Sent through the
 * same channels as budget threshold alerts.
 */

import type { AlertChannel } from "@/db/schema";
import {
  emailMessage,
  postToChannel,
  slackEscape,
  usd,
  type AlertConfig,
  type ChannelMessage,
  type DeliveryOptions,
  type DeliveryResult,
} from "./budget-notifications";
import type { EmailContent } from "./email";
import { forecastMonth, forecastOverBudget } from "./forecast";
import { detectSpike } from "./spike";

export const SIGNAL_KINDS = ["forecast", "spike"] as const;
export type SignalKind = (typeof SIGNAL_KINDS)[number];

export const SIGNAL_EVENTS: Record<SignalKind, string> = {
  forecast: "spend.forecast_over_budget",
  spike: "spend.spike",
};

interface SignalProject {
  id: string;
  name: string;
  slug: string;
}

export type SignalAlert =
  | {
      kind: "forecast";
      project: SignalProject;
      /** The UTC month, e.g. "2026-11": one notification per month. */
      period: string;
      spentUsd: string;
      projectedUsd: string;
      budgetUsd: string;
      /** The month's last day, e.g. "2026-11-30". */
      lastDay: string;
    }
  | {
      kind: "spike";
      project: SignalProject;
      /** The UTC day, e.g. "2026-11-06": one notification per day. */
      period: string;
      todayUsd: string;
      dailyAverageUsd: string;
      /** Today as a multiple of the average; null after an idle week. */
      multiple: number | null;
    };

/** The amount a notification reported, and what it was compared with. */
export function signalAmounts(alert: SignalAlert): {
  amountUsd: string;
  referenceUsd: string;
} {
  return alert.kind === "forecast"
    ? { amountUsd: alert.projectedUsd, referenceUsd: alert.budgetUsd }
    : { amountUsd: alert.todayUsd, referenceUsd: alert.dailyAverageUsd };
}

/**
 * The signals to send now: a forecast over budget for projects not over
 * it yet, and a spike for projects spiking today, by the same rules the
 * overview shows.
 */
export function planSignalAlerts(
  projects: Array<
    SignalProject & {
      today: string;
      month: string;
      last7FullDays: string;
      monthlyBudgetUsd: string | null;
    }
  >,
  now: Date,
): SignalAlert[] {
  const day = now.toISOString().slice(0, 10);
  const alerts: SignalAlert[] = [];
  for (const p of projects) {
    const project = { id: p.id, name: p.name, slug: p.slug };
    const forecast = forecastMonth(p.month, p.last7FullDays, now);
    if (
      p.monthlyBudgetUsd !== null &&
      forecastOverBudget(p.month, forecast.projectedUsd, p.monthlyBudgetUsd)
    ) {
      alerts.push({
        kind: "forecast",
        project,
        period: day.slice(0, 7),
        spentUsd: p.month,
        projectedUsd: forecast.projectedUsd,
        budgetUsd: p.monthlyBudgetUsd,
        lastDay: forecast.lastDay.toISOString().slice(0, 10),
      });
    }
    const spike = detectSpike(p.today, p.last7FullDays);
    if (spike.spike) {
      alerts.push({
        kind: "spike",
        project,
        period: day,
        todayUsd: p.today,
        dailyAverageUsd: spike.dailyAverageUsd,
        multiple: spike.multiple,
      });
    }
  }
  return alerts;
}

/** The webhook's JSON body; amounts are exact decimal strings. */
export function signalWebhookPayload(alert: SignalAlert, sentAt: Date) {
  const { kind, ...fields } = alert;
  return {
    type: SIGNAL_EVENTS[kind],
    ...fields,
    sentAt: sentAt.toISOString(),
  };
}

/** The signal as a sentence, with the name already formatted. */
function signalSentence(alert: SignalAlert, name: string): string {
  if (alert.kind === "forecast") {
    return `${name} is on pace to exceed its ${usd(alert.budgetUsd)} monthly budget: ${usd(alert.projectedUsd)} projected by ${alert.lastDay}, ${usd(alert.spentUsd)} spent so far.`;
  }
  const multiple =
    alert.multiple === null
      ? "after a week without spend"
      : `${alert.multiple.toFixed(1)}× its usual ${usd(alert.dailyAverageUsd)} a day`;
  return `${name} is spiking: ${usd(alert.todayUsd)} spent today (${alert.period} UTC), ${multiple}.`;
}

/** A Slack incoming-webhook body. */
export function signalSlackPayload(alert: SignalAlert): { text: string } {
  const name = `*${slackEscape(alert.project.name)}*`;
  const icon =
    alert.kind === "forecast" ? ":crystal_ball:" : ":chart_with_upwards_trend:";
  return { text: `${icon} ${signalSentence(alert, name)}` };
}

export function signalEmail(alert: SignalAlert): EmailContent {
  const { name } = alert.project;
  return emailMessage(
    alert.kind === "forecast"
      ? `${name}: on pace to exceed its ${usd(alert.budgetUsd)} budget`
      : `${name}: spending spike on ${alert.period}`,
    signalSentence(alert, name),
  );
}

export function signalMessage(alert: SignalAlert, now: Date): ChannelMessage {
  return {
    event: SIGNAL_EVENTS[alert.kind],
    webhookBody: signalWebhookPayload(alert, now),
    slackBody: signalSlackPayload(alert),
    email: signalEmail(alert),
  };
}

/** Sends one signal to one channel. Never throws. */
export function deliverSignal(
  alert: SignalAlert,
  channel: AlertChannel,
  config: AlertConfig,
  options: DeliveryOptions = {},
): Promise<DeliveryResult> {
  const now = options.now ?? new Date();
  return postToChannel(channel, config, signalMessage(alert, now), {
    ...options,
    now,
  });
}
