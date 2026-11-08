import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  alertPeriod,
  budgetEmail,
  configuredChannels,
  deliverAlert,
  parseAlertConfig,
  planBudgetAlerts,
  signWebhook,
  slackPayload,
  webhookPayload,
  type BudgetAlert,
} from "./budget-notifications";

const NOW = new Date("2026-11-05T09:30:00Z");

const project = (
  name: string,
  month: string,
  monthlyBudgetUsd: string | null,
) => ({
  id: `id-${name}`,
  name,
  slug: name.toLowerCase(),
  month,
  monthlyBudgetUsd,
});

describe("parseAlertConfig", () => {
  it("is empty when nothing is set, or only blanks", () => {
    expect(parseAlertConfig({})).toEqual({});
    expect(
      parseAlertConfig({
        BUDGET_ALERT_WEBHOOK_URL: "  ",
        BUDGET_ALERT_SLACK_WEBHOOK_URL: "",
      }),
    ).toEqual({});
  });

  it("reads both destinations and the signing secret", () => {
    const config = parseAlertConfig({
      BUDGET_ALERT_WEBHOOK_URL: "https://hooks.example.com/budget",
      BUDGET_ALERT_WEBHOOK_SECRET: "s".repeat(32),
      BUDGET_ALERT_SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/T/B/x",
    });
    expect(config).toEqual({
      webhook: {
        url: "https://hooks.example.com/budget",
        secret: "s".repeat(32),
      },
      slack: { url: "https://hooks.slack.com/services/T/B/x" },
    });
    expect(configuredChannels(config)).toEqual(["webhook", "slack"]);
  });

  it("allows a plain-http webhook, for a receiver on a private network", () => {
    expect(
      parseAlertConfig({ BUDGET_ALERT_WEBHOOK_URL: "http://alerts:8080/in" }),
    ).toEqual({ webhook: { url: "http://alerts:8080/in" } });
  });

  it.each([
    [{ BUDGET_ALERT_WEBHOOK_URL: "not a url" }, /BUDGET_ALERT_WEBHOOK_URL/],
    [{ BUDGET_ALERT_WEBHOOK_URL: "ftp://x.example" }, /http\(s\)/],
    [{ BUDGET_ALERT_SLACK_WEBHOOK_URL: "http://hooks.slack.com/x" }, /https/],
    [
      {
        BUDGET_ALERT_WEBHOOK_URL: "https://x.example",
        BUDGET_ALERT_WEBHOOK_SECRET: "short",
      },
      /16 characters/,
    ],
    [{ BUDGET_ALERT_WEBHOOK_SECRET: "s".repeat(32) }, /without/],
  ])("rejects %j", (env, message) => {
    expect(() => parseAlertConfig(env)).toThrow(message);
  });
});

describe("planBudgetAlerts", () => {
  it("alerts at the highest threshold reached, compared exactly", () => {
    const alerts = planBudgetAlerts(
      [
        project("Under", "79.999999", "100.00"),
        project("Warning", "80.000000", "100.00"),
        project("Over", "250.500000", "100.00"),
        project("Exactly", "100.000000", "100.00"),
        project("NoBudget", "9999.000000", null),
      ],
      NOW,
    );
    expect(
      alerts.map((a) => [a.project.name, a.thresholdPercent, a.status]),
    ).toEqual([
      ["Warning", 80, "warning"],
      ["Over", 100, "over"],
      ["Exactly", 100, "over"],
    ]);
    expect(alerts[1]).toMatchObject({
      period: "2026-11",
      spentUsd: "250.500000",
      budgetUsd: "100.00",
      usedPercent: "250.5%",
    });
  });

  it("treats spend against a zero budget as over, with no percentage", () => {
    const [alert] = planBudgetAlerts(
      [project("Zero", "0.010000", "0.00")],
      NOW,
    );
    expect(alert).toMatchObject({ status: "over", usedPercent: null });
    expect(
      planBudgetAlerts([project("Idle", "0.000000", "0.00")], NOW),
    ).toEqual([]);
  });

  it("uses the UTC month", () => {
    expect(alertPeriod(new Date("2026-11-30T23:59:59Z"))).toBe("2026-11");
    expect(alertPeriod(new Date("2026-12-01T00:00:00Z"))).toBe("2026-12");
  });
});

const alert = (overrides: Partial<BudgetAlert> = {}): BudgetAlert => ({
  project: { id: "p1", name: "Support Bot", slug: "support-bot" },
  period: "2026-11",
  thresholdPercent: 80,
  status: "warning",
  spentUsd: "81.234567",
  budgetUsd: "100.00",
  usedPercent: "81.2%",
  ...overrides,
});

describe("payloads", () => {
  it("sends the webhook the exact amounts", () => {
    expect(webhookPayload(alert(), NOW)).toEqual({
      type: "budget.threshold_reached",
      project: { id: "p1", name: "Support Bot", slug: "support-bot" },
      period: "2026-11",
      thresholdPercent: 80,
      status: "warning",
      spentUsd: "81.234567",
      budgetUsd: "100.00",
      usedPercent: "81.2%",
      sentAt: "2026-11-05T09:30:00.000Z",
    });
  });

  it("words Slack messages for each status", () => {
    expect(slackPayload(alert()).text).toBe(
      ":warning: *Support Bot* has used 81.2% of its $100.00 monthly budget for 2026-11: $81.23 spent.",
    );
    expect(
      slackPayload(
        alert({
          thresholdPercent: 100,
          status: "over",
          spentUsd: "1234.5",
          usedPercent: "1234.5%",
        }),
      ).text,
    ).toBe(
      ":rotating_light: *Support Bot* is over its $100.00 monthly budget for 2026-11: $1,234.50 spent (1234.5%).",
    );
    expect(
      slackPayload(
        alert({
          status: "over",
          thresholdPercent: 100,
          budgetUsd: "0.00",
          spentUsd: "0.01",
          usedPercent: null,
        }),
      ).text,
    ).toBe(
      ":rotating_light: *Support Bot* is over its $0.00 monthly budget for 2026-11: $0.01 spent.",
    );
  });

  it("escapes Slack markup in project names", () => {
    const text = slackPayload(
      alert({ project: { id: "p", name: "R&D <!channel>", slug: "rd" } }),
    ).text;
    expect(text).toContain("*R&amp;D &lt;!channel&gt;*");
    expect(text).not.toContain("<!channel>");
  });
});

describe("signWebhook", () => {
  it("signs the timestamp and body with HMAC-SHA256", () => {
    const body = '{"a":1}';
    const signature = signWebhook(body, "secret-secret-123", NOW);
    const t = Math.floor(NOW.getTime() / 1000);
    const expected = createHmac("sha256", "secret-secret-123")
      .update(`${t}.${body}`)
      .digest("hex");
    expect(signature).toBe(`t=${t},v1=${expected}`);
  });
});

describe("deliverAlert", () => {
  const config = {
    webhook: { url: "https://hooks.example.com/b", secret: "s".repeat(20) },
    slack: { url: "https://hooks.slack.com/services/x" },
  };
  const ok = () => vi.fn(async () => new Response("ok"));
  const callOf = (fetch: ReturnType<typeof ok>) =>
    fetch.mock.calls[0] as unknown as [string, RequestInit];

  it("posts a signed JSON event to the webhook", async () => {
    const fetch = ok();
    expect(
      await deliverAlert(alert(), "webhook", config, { fetch, now: NOW }),
    ).toEqual({ ok: true });
    const [url, init] = callOf(fetch);
    expect(url).toBe("https://hooks.example.com/b");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-cost-tracker-event"]).toBe("budget.threshold_reached");
    expect(headers["x-cost-tracker-signature"]).toBe(
      signWebhook(init.body as string, "s".repeat(20), NOW),
    );
    expect(JSON.parse(init.body as string).spentUsd).toBe("81.234567");
    expect(init.redirect).toBe("manual");
  });

  it("leaves the signature off without a secret, and off Slack", async () => {
    const fetch = ok();
    await deliverAlert(
      alert(),
      "webhook",
      { webhook: { url: config.webhook.url } },
      { fetch },
    );
    expect(callOf(fetch)[1].headers).not.toHaveProperty(
      "x-cost-tracker-signature",
    );
    const slack = ok();
    await deliverAlert(alert(), "slack", config, { fetch: slack });
    const [url, init] = callOf(slack);
    expect(url).toBe(config.slack.url);
    expect(init.headers).not.toHaveProperty("x-cost-tracker-signature");
    expect(JSON.parse(init.body as string)).toHaveProperty("text");
  });

  it("reports failures instead of throwing", async () => {
    const status = vi.fn(async () => new Response("no", { status: 500 }));
    expect(
      await deliverAlert(alert(), "slack", config, { fetch: status }),
    ).toEqual({ ok: false, error: "HTTP 500" });
    const redirect = vi.fn(
      async () =>
        new Response(null, { status: 302, headers: { location: "/x" } }),
    );
    expect(
      (await deliverAlert(alert(), "webhook", config, { fetch: redirect })).ok,
    ).toBe(false);
    const network = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    expect(
      await deliverAlert(alert(), "webhook", config, { fetch: network }),
    ).toEqual({ ok: false, error: "fetch failed" });
    expect(
      await deliverAlert(alert(), "slack", {}, { fetch: network }),
    ).toEqual({ ok: false, error: "slack isn't configured" });
  });
});

describe("email", () => {
  const smtp = {
    BUDGET_ALERT_SMTP_URL: "smtps://alerts:hunter2@mail.example.com:465",
    BUDGET_ALERT_EMAIL_FROM: "alerts@example.com",
    BUDGET_ALERT_EMAIL_TO: "a@example.com, b@example.com",
  };
  const email = {
    smtpUrl: smtp.BUDGET_ALERT_SMTP_URL,
    from: "alerts@example.com",
    to: ["a@example.com", "b@example.com"],
  };

  it("reads the destination, with a list of recipients", () => {
    const config = parseAlertConfig(smtp);
    expect(config).toEqual({ email });
    expect(configuredChannels(config)).toEqual(["email"]);
  });

  it.each([
    ["BUDGET_ALERT_SMTP_URL"],
    ["BUDGET_ALERT_EMAIL_FROM"],
    ["BUDGET_ALERT_EMAIL_TO"],
  ])("needs all three settings, not just without %s", (missing) => {
    expect(() => parseAlertConfig({ ...smtp, [missing]: "" })).toThrow(
      /together/,
    );
  });

  it.each([
    [{ BUDGET_ALERT_SMTP_URL: "https://mail.example.com" }, /SMTP_URL/],
    [{ BUDGET_ALERT_SMTP_URL: "smtp://u:bad%zz@mail.example.com" }, /encoded/],
    [{ BUDGET_ALERT_EMAIL_FROM: "not an address" }, /EMAIL_FROM/],
    [{ BUDGET_ALERT_EMAIL_TO: "a@example.com, nope" }, /EMAIL_TO/],
  ])("rejects %j", (override, message) => {
    expect(() => parseAlertConfig({ ...smtp, ...override })).toThrow(message);
  });

  it("doesn't repeat the password in a configuration error", () => {
    let message = "";
    try {
      parseAlertConfig({
        ...smtp,
        BUDGET_ALERT_SMTP_URL: "ftp://alerts:hunter2@mail.example.com",
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("BUDGET_ALERT_SMTP_URL");
    expect(message).not.toContain("hunter2");
  });

  it("words the message for each status, without Slack markup", () => {
    expect(budgetEmail(alert())).toEqual({
      subject: "Support Bot: 81.2% of budget used for 2026-11",
      text: "Support Bot has used 81.2% of its $100.00 monthly budget for 2026-11: $81.23 spent.\n\nSent by AI API Cost Tracker.\n",
    });
    expect(
      budgetEmail({
        ...alert(),
        status: "over",
        thresholdPercent: 100,
        spentUsd: "120.000000",
        usedPercent: "120.0%",
      }).subject,
    ).toBe("Support Bot: over budget for 2026-11");
  });

  it("keeps the subject to one line and the name as typed", () => {
    const base = alert();
    const content = budgetEmail({
      ...base,
      project: { ...base.project, name: "R&D\r\nBcc: x@example.com" },
    });
    expect(content.subject).toBe(
      "R&D Bcc: x@example.com: 81.2% of budget used for 2026-11",
    );
  });

  const config = { email };

  it("sends the message to the configured server", async () => {
    const sendEmail = vi.fn(async () => ({ rejected: [] }));
    await expect(
      deliverAlert(alert(), "email", config, { sendEmail }),
    ).resolves.toEqual({ ok: true });
    expect(sendEmail).toHaveBeenCalledWith(email, budgetEmail(alert()));
  });

  it("counts a partly refused message as sent, and says so", async () => {
    const sendEmail = vi.fn(async () => ({ rejected: ["b@example.com"] }));
    await expect(
      deliverAlert(alert(), "email", config, { sendEmail }),
    ).resolves.toEqual({
      ok: true,
      note: "refused recipients: b@example.com",
    });
  });

  it("reports failures instead of throwing", async () => {
    const sendEmail = vi.fn(async () => {
      throw new Error("Connection timeout");
    });
    await expect(
      deliverAlert(alert(), "email", config, { sendEmail }),
    ).resolves.toEqual({ ok: false, error: "Connection timeout" });
    await expect(deliverAlert(alert(), "email", {})).resolves.toEqual({
      ok: false,
      error: "email isn't configured",
    });
  });
});
