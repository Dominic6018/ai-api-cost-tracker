import "dotenv/config";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { AlertConfig } from "@/lib/budget-notifications";
import { parseEnv } from "@/lib/env";
import { runBudgetAlerts, type AlertResult } from "./budget-notifications";
import { budgetNotifications, projects, usageEvents } from "./schema";

// Runs against the database in DATABASE_URL after `npm run db:migrate`.
const client = postgres(parseEnv().DATABASE_URL, {
  max: 1,
  onnotice: () => {},
});
const db = drizzle(client);

const config: AlertConfig = {
  webhook: { url: "https://hooks.example.com/budget" },
  slack: { url: "https://hooks.slack.com/services/T/B/x" },
};

const created: string[] = [];

afterAll(async () => {
  // Deleting the projects cascades to their usage and notifications.
  if (created.length > 0) {
    await db.delete(projects).where(inArray(projects.id, created));
  }
  await client.end();
});

/**
 * Projects with the given budget and spend, in a month years ahead that
 * only this test uses, so other usage in the database can't change it.
 */
async function setup(
  month: string,
  specs: Array<{ budget: string | null; spent: string }>,
) {
  const rows = await db
    .insert(projects)
    .values(
      specs.map(({ budget }, i) => ({
        name: `Alerts ${month} ${i}`,
        slug: `it-${randomUUID()}`,
        monthlyBudgetUsd: budget,
      })),
    )
    .returning({ id: projects.id });
  const ids = rows.map((row) => row.id);
  created.push(...ids);
  const now = new Date(`${month}-15T12:00:00Z`);
  await spend(
    ids,
    specs.map((s) => s.spent),
    new Date(`${month}-02T00:00:00Z`),
  );
  return { ids, now };
}

async function spend(ids: string[], amounts: string[], occurredAt: Date) {
  const values = ids
    .map((projectId, i) => ({
      projectId,
      provider: "openai" as const,
      model: "alerts-test",
      costUsd: amounts[i],
      occurredAt,
    }))
    .filter((event) => Number(event.costUsd) > 0);
  if (values.length > 0) await db.insert(usageEvents).values(values);
}

const okFetch = () => vi.fn<typeof fetch>(async () => new Response("ok"));

/** The results for these projects, as comparable tuples. */
const summary = (results: AlertResult[], ids: string[]) =>
  results
    .filter((r) => ids.includes(r.alert.project.id))
    .map((r) => [
      ids.indexOf(r.alert.project.id),
      r.alert.thresholdPercent,
      r.channel,
      r.outcome,
    ])
    .sort((a, b) => String(a).localeCompare(String(b)));

const stored = (ids: string[]) =>
  db
    .select({
      projectId: budgetNotifications.projectId,
      period: budgetNotifications.period,
      thresholdPercent: budgetNotifications.thresholdPercent,
      channel: budgetNotifications.channel,
      spentUsd: budgetNotifications.spentUsd,
    })
    .from(budgetNotifications)
    .where(inArray(budgetNotifications.projectId, ids));

describe("runBudgetAlerts", () => {
  it("notifies each channel once, at the highest threshold reached", async () => {
    const { ids, now } = await setup("2032-01", [
      { budget: "100.00", spent: "80.000000" }, // exactly 80%
      { budget: "100.00", spent: "250.000000" }, // straight past 100%
      { budget: "100.00", spent: "79.999999" },
      { budget: null, spent: "500.000000" },
    ]);
    const fetch = okFetch();
    const first = await runBudgetAlerts(db, { config, now, fetch });
    expect(summary(first, ids)).toEqual([
      [0, 80, "slack", "sent"],
      [0, 80, "webhook", "sent"],
      [1, 100, "slack", "sent"],
      [1, 100, "webhook", "sent"],
    ]);
    expect(fetch).toHaveBeenCalledTimes(4);
    const rows = await stored(ids);
    expect(rows).toHaveLength(4);
    expect(rows.find((r) => r.projectId === ids[1])).toMatchObject({
      period: "2032-01",
      spentUsd: "250.000000",
    });

    // Running again sends nothing new.
    const again = okFetch();
    const second = await runBudgetAlerts(db, { config, now, fetch: again });
    expect(again).not.toHaveBeenCalled();
    expect(summary(second, ids).every((r) => r[3] === "already_sent")).toBe(
      true,
    );
  });

  it("sends 100% after 80%, but not 80% again after 100%", async () => {
    const { ids, now } = await setup("2032-02", [
      { budget: "10.00", spent: "8.500000" },
    ]);
    const slackOnly: AlertConfig = { slack: config.slack };
    await runBudgetAlerts(db, { config: slackOnly, now, fetch: okFetch() });

    await spend(ids, ["2.000000"], new Date("2032-02-10T00:00:00Z"));
    const fetch = okFetch();
    expect(
      summary(
        await runBudgetAlerts(db, { config: slackOnly, now, fetch }),
        ids,
      ),
    ).toEqual([[0, 100, "slack", "sent"]]);

    // Raising the budget brings it back to 87%: already told it was over.
    await db
      .update(projects)
      .set({ monthlyBudgetUsd: "12.00" })
      .where(eq(projects.id, ids[0]));
    const quiet = okFetch();
    expect(
      summary(
        await runBudgetAlerts(db, { config: slackOnly, now, fetch: quiet }),
        ids,
      ),
    ).toEqual([[0, 80, "slack", "already_sent"]]);
    expect(quiet).not.toHaveBeenCalled();
  });

  it("starts again each month", async () => {
    const { ids, now } = await setup("2032-03", [
      { budget: "10.00", spent: "9.000000" },
    ]);
    const webhookOnly: AlertConfig = { webhook: config.webhook };
    await runBudgetAlerts(db, { config: webhookOnly, now, fetch: okFetch() });
    await spend(ids, ["9.000000"], new Date("2032-04-02T00:00:00Z"));
    const april = new Date("2032-04-15T12:00:00Z");
    const fetch = okFetch();
    expect(
      summary(
        await runBudgetAlerts(db, { config: webhookOnly, now: april, fetch }),
        ids,
      ),
    ).toEqual([[0, 80, "webhook", "sent"]]);
    expect((await stored(ids)).map((r) => r.period).sort()).toEqual([
      "2032-03",
      "2032-04",
    ]);
  });

  it("doesn't record a failed delivery, so the next run retries it", async () => {
    const { ids, now } = await setup("2032-05", [
      { budget: "10.00", spent: "11.000000" },
      { budget: "10.00", spent: "9.000000" },
    ]);
    // Slack is down; the webhook and the other project still go out.
    const flaky = vi.fn<typeof fetch>(async (url) =>
      String(url).includes("slack")
        ? new Response("down", { status: 503 })
        : new Response("ok"),
    );
    const first = await runBudgetAlerts(db, { config, now, fetch: flaky });
    expect(summary(first, ids)).toEqual([
      [0, 100, "slack", "failed"],
      [0, 100, "webhook", "sent"],
      [1, 80, "slack", "failed"],
      [1, 80, "webhook", "sent"],
    ]);
    expect(first.find((r) => r.outcome === "failed")?.error).toBe("HTTP 503");
    expect((await stored(ids)).map((r) => r.channel)).toEqual([
      "webhook",
      "webhook",
    ]);

    const retry = okFetch();
    expect(
      summary(await runBudgetAlerts(db, { config, now, fetch: retry }), ids),
    ).toEqual([
      [0, 100, "slack", "sent"],
      [0, 100, "webhook", "already_sent"],
      [1, 80, "slack", "sent"],
      [1, 80, "webhook", "already_sent"],
    ]);
    expect(retry).toHaveBeenCalledTimes(2);
  });

  it("sends nothing and records nothing in a dry run", async () => {
    const { ids, now } = await setup("2032-06", [
      { budget: "10.00", spent: "10.000000" },
    ]);
    const fetch = okFetch();
    expect(
      summary(
        await runBudgetAlerts(db, { config, now, fetch, dryRun: true }),
        ids,
      ),
    ).toEqual([
      [0, 100, "slack", "would_send"],
      [0, 100, "webhook", "would_send"],
    ]);
    expect(fetch).not.toHaveBeenCalled();
    expect(await stored(ids)).toEqual([]);
  });

  it("doesn't send twice when two runs overlap", async () => {
    const { ids, now } = await setup("2032-07", [
      { budget: "10.00", spent: "8.000000" },
      { budget: "10.00", spent: "12.000000" },
    ]);
    const fetch = okFetch();
    const [a, b] = await Promise.all([
      runBudgetAlerts(db, { config, now, fetch }),
      runBudgetAlerts(db, { config, now, fetch }),
    ]);
    const sent = [...summary(a, ids), ...summary(b, ids)].filter(
      (r) => r[3] === "sent",
    );
    expect(sent).toHaveLength(4);
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(await stored(ids)).toHaveLength(4);
  });

  it("does nothing without a destination", async () => {
    const { now } = await setup("2032-08", [
      { budget: "1.00", spent: "5.000000" },
    ]);
    const fetch = okFetch();
    expect(await runBudgetAlerts(db, { config: {}, now, fetch })).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });
});
