import { describe, expect, it, vi } from "vitest";
import { signWebhook } from "./budget-notifications";
import {
  deliverSignal,
  planSignalAlerts,
  signalAmounts,
  signalSlackPayload,
  signalWebhookPayload,
  type SignalAlert,
} from "./spend-signals";

// Nov 24 00:00 UTC: exactly 7 days left in November.
const NOW = new Date("2026-11-24T00:00:00Z");

const project = (
  overrides: Partial<{
    today: string;
    month: string;
    last7FullDays: string;
    monthlyBudgetUsd: string | null;
  }> = {},
) => ({
  id: "p1",
  name: "Support Bot",
  slug: "support-bot",
  today: "0.000000",
  month: "50.000000",
  last7FullDays: "14.000000", // $2 a day
  monthlyBudgetUsd: "100.00",
  ...overrides,
});

describe("planSignalAlerts", () => {
  it("sends nothing for a project on budget and at its usual pace", () => {
    // $50 + 7 days × $2 = $64 of $100; today $5 is under 3× $2.
    expect(planSignalAlerts([project({ today: "5.000000" })], NOW)).toEqual([]);
  });

  it("warns once a month when the forecast reaches the budget", () => {
    // $90 + 7 days × $2 = $104 of $100.
    expect(planSignalAlerts([project({ month: "90.000000" })], NOW)).toEqual([
      {
        kind: "forecast",
        project: { id: "p1", name: "Support Bot", slug: "support-bot" },
        period: "2026-11",
        spentUsd: "90.000000",
        projectedUsd: "104.000000",
        budgetUsd: "100.00",
        lastDay: "2026-11-30",
      },
    ]);
  });

  it("doesn't forecast for projects already over, or without a budget", () => {
    expect(
      planSignalAlerts(
        [
          project({ month: "100.000000" }),
          project({ month: "99.000000", monthlyBudgetUsd: null }),
        ],
        NOW,
      ),
    ).toEqual([]);
  });

  it("flags a spike for today's UTC day", () => {
    expect(
      planSignalAlerts(
        [project({ today: "6.000000", month: "10.000000" })],
        new Date("2026-11-24T15:30:00Z"),
      ),
    ).toEqual([
      {
        kind: "spike",
        project: { id: "p1", name: "Support Bot", slug: "support-bot" },
        period: "2026-11-24",
        todayUsd: "6.000000",
        dailyAverageUsd: "2.000000",
        multiple: 3,
      },
    ]);
  });

  it("can send both for one project", () => {
    const kinds = planSignalAlerts(
      [project({ today: "30.000000", month: "95.000000" })],
      NOW,
    ).map((alert) => alert.kind);
    expect(kinds).toEqual(["forecast", "spike"]);
  });
});

const forecast: SignalAlert = {
  kind: "forecast",
  project: { id: "p1", name: "R&D <bot>", slug: "rd" },
  period: "2026-11",
  spentUsd: "90.000000",
  projectedUsd: "104.000000",
  budgetUsd: "100.00",
  lastDay: "2026-11-30",
};
const spike: SignalAlert = {
  kind: "spike",
  project: { id: "p1", name: "Support Bot", slug: "support-bot" },
  period: "2026-11-24",
  todayUsd: "10.400000",
  dailyAverageUsd: "2.000000",
  multiple: 5.2,
};

describe("messages", () => {
  it("sends the webhook its event type and exact amounts", () => {
    expect(signalWebhookPayload(spike, NOW)).toEqual({
      type: "spend.spike",
      project: { id: "p1", name: "Support Bot", slug: "support-bot" },
      period: "2026-11-24",
      todayUsd: "10.400000",
      dailyAverageUsd: "2.000000",
      multiple: 5.2,
      sentAt: "2026-11-24T00:00:00.000Z",
    });
    expect(signalWebhookPayload(forecast, NOW)).toMatchObject({
      type: "spend.forecast_over_budget",
      projectedUsd: "104.000000",
      budgetUsd: "100.00",
    });
  });

  it("words Slack messages, escaping project names", () => {
    expect(signalSlackPayload(forecast).text).toBe(
      ":crystal_ball: *R&amp;D &lt;bot&gt;* is on pace to exceed its $100.00 monthly budget: $104.00 projected by 2026-11-30, $90.00 spent so far.",
    );
    expect(signalSlackPayload(spike).text).toBe(
      ":chart_with_upwards_trend: *Support Bot* is spiking: $10.40 spent today (2026-11-24 UTC), 5.2× its usual $2.00 a day.",
    );
    expect(
      signalSlackPayload({
        ...spike,
        multiple: null,
        dailyAverageUsd: "0.000000",
      }).text,
    ).toContain("after a week without spend");
  });

  it("records what each message reported", () => {
    expect(signalAmounts(forecast)).toEqual({
      amountUsd: "104.000000",
      referenceUsd: "100.00",
    });
    expect(signalAmounts(spike)).toEqual({
      amountUsd: "10.400000",
      referenceUsd: "2.000000",
    });
  });
});

describe("deliverSignal", () => {
  it("posts a signed event with the signal's type", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response("ok"),
    );
    const config = {
      webhook: { url: "https://hooks.example.com/b", secret: "s".repeat(20) },
    };
    expect(
      await deliverSignal(spike, "webhook", config, { fetch, now: NOW }),
    ).toEqual({ ok: true });
    const [, init] = fetch.mock.calls[0];
    const headers = init?.headers as Record<string, string>;
    expect(headers["x-cost-tracker-event"]).toBe("spend.spike");
    expect(headers["x-cost-tracker-signature"]).toBe(
      signWebhook(init?.body as string, "s".repeat(20), NOW),
    );
    expect(init?.redirect).toBe("manual");
  });
});
