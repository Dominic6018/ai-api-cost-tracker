import { and, asc, desc, eq, gte, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { FORECAST_PACE_DAYS, forecastPaceWindow } from "@/lib/forecast";
import { earliestWindowStart, spendWindows } from "@/lib/spend";
import { projects, usageEvents } from "./schema";
import { inOrganization, type OrganizationScope } from "./scope";

/** Any Drizzle Postgres database, so callers and tests can pass their own. */
type Database = Pick<PgDatabase<PgQueryResultHKT>, "select">;

/** Spend in USD as decimal strings, so sums stay exact. */
export interface SpendTotals {
  today: string;
  month: string;
  last30Days: string;
  /** The last 7 full UTC days, before today: the forecast's pace. */
  last7FullDays: string;
  /** Each of those 7 days, oldest first: the forecast's range. */
  paceDaysUsd: string[];
  /**
   * The earliest usage in the widest window, or null without any: whether
   * there's a full pace window of history to forecast from.
   */
  earliestUsageAt: Date | null;
  /** Usage events in the widest window. */
  events: number;
}

export interface ProjectSpend extends SpendTotals {
  id: string;
  name: string;
  slug: string;
  /** USD as a decimal string, or null when the project has no budget. */
  monthlyBudgetUsd: string | null;
}

export interface SpendOverview {
  windows: ReturnType<typeof spendWindows>;
  totals: SpendTotals;
  /** Every project, including those with no spend, highest month spend first. */
  projects: ProjectSpend[];
}

/**
 * Totals per window for each project and overall, in one SQL query.
 * `ROLLUP` adds the overall row, so totals are summed by Postgres in
 * `numeric` rather than in floating point.
 */
export async function getSpendOverview(
  db: Database,
  scope: OrganizationScope,
  now: Date = new Date(),
): Promise<SpendOverview> {
  const windows = spendWindows(now);
  // Raw `sql` parameters bypass column type mapping, and the postgres-js
  // driver doesn't serialize Date objects, so pass ISO strings.
  const sumSince = (start: Date) =>
    sql`coalesce(sum(${usageEvents.costUsd}) filter (where ${usageEvents.occurredAt} >= ${start.toISOString()}::timestamptz), 0)::numeric(14, 6)`;
  const pace = forecastPaceWindow(now);
  const sumPace = sql`coalesce(sum(${usageEvents.costUsd}) filter (where ${usageEvents.occurredAt} >= ${pace.start.toISOString()}::timestamptz and ${usageEvents.occurredAt} < ${pace.end.toISOString()}::timestamptz), 0)::numeric(14, 6)`;
  const asText = (amount: ReturnType<typeof sumSince>) =>
    sql<string>`${amount}::text`;
  const DAY_MS = 86_400_000;
  const paceDays = sql<string>`concat_ws(',', ${Array.from(
    { length: FORECAST_PACE_DAYS },
    (_, i) => {
      const from = new Date(pace.start.getTime() + i * DAY_MS).toISOString();
      const to = new Date(
        pace.start.getTime() + (i + 1) * DAY_MS,
      ).toISOString();
      return sql`(coalesce(sum(${usageEvents.costUsd}) filter (where ${usageEvents.occurredAt} >= ${from}::timestamptz and ${usageEvents.occurredAt} < ${to}::timestamptz), 0)::numeric(14, 6))::text`;
    },
  ).reduce((list, day) => sql`${list}, ${day}`)})`;

  const monthSum = sumSince(windows.month);
  const rows = await db
    .select({
      id: projects.id,
      name: projects.name,
      slug: projects.slug,
      monthlyBudgetUsd: projects.monthlyBudgetUsd,
      today: asText(sumSince(windows.today)),
      month: asText(monthSum),
      last30Days: asText(sumSince(windows.last30Days)),
      last7FullDays: asText(sumPace),
      paceDays,
      // Epoch milliseconds: Postgres's text form of a timestamp isn't ISO.
      earliest: sql<
        string | null
      >`(extract(epoch from min(${usageEvents.occurredAt})) * 1000)::bigint::text`,
      events: sql<number>`count(${usageEvents.id})::int`,
      isTotal: sql<boolean>`grouping(${projects.id}) = 1`,
    })
    .from(projects)
    .leftJoin(
      usageEvents,
      and(
        eq(usageEvents.projectId, projects.id),
        gte(usageEvents.occurredAt, earliestWindowStart(windows)),
      ),
    )
    .where(inOrganization(scope))
    .groupBy(
      sql`rollup((${projects.id}, ${projects.name}, ${projects.slug}, ${projects.monthlyBudgetUsd}))`,
    )
    // Order by the numeric sum; ordering the text form would put "10" before "9".
    .orderBy(desc(monthSum), asc(projects.name));

  const zero = {
    today: "0.000000",
    month: "0.000000",
    last30Days: "0.000000",
    last7FullDays: "0.000000",
    paceDaysUsd: Array<string>(FORECAST_PACE_DAYS).fill("0.000000"),
    earliestUsageAt: null,
    events: 0,
  };
  const strip = (row: {
    today: string;
    month: string;
    last30Days: string;
    last7FullDays: string;
    paceDays: string;
    earliest: string | null;
    events: number;
  }): SpendTotals => ({
    today: row.today,
    month: row.month,
    last30Days: row.last30Days,
    last7FullDays: row.last7FullDays,
    paceDaysUsd: row.paceDays.split(","),
    earliestUsageAt:
      row.earliest === null ? null : new Date(Number(row.earliest)),
    events: row.events,
  });

  const totalRow = rows.find((row) => row.isTotal);
  return {
    windows,
    totals: totalRow ? strip(totalRow) : zero,
    projects: rows
      .filter((row) => !row.isTotal)
      .map((row) => ({
        id: row.id,
        name: row.name,
        slug: row.slug,
        monthlyBudgetUsd: row.monthlyBudgetUsd,
        ...strip(row),
      })),
  };
}
