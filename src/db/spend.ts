import { and, asc, desc, eq, gte, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { earliestWindowStart, spendWindows } from "@/lib/spend";
import { projects, usageEvents } from "./schema";

/** Any Drizzle Postgres database, so callers and tests can pass their own. */
type Database = Pick<PgDatabase<PgQueryResultHKT>, "select">;

/** Spend in USD as decimal strings, so sums stay exact. */
export interface SpendTotals {
  today: string;
  month: string;
  last30Days: string;
  /** Usage events in the widest window. */
  events: number;
}

export interface ProjectSpend extends SpendTotals {
  id: string;
  name: string;
  slug: string;
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
  now: Date = new Date(),
): Promise<SpendOverview> {
  const windows = spendWindows(now);
  // Raw `sql` parameters bypass column type mapping, and the postgres-js
  // driver doesn't serialize Date objects, so pass ISO strings.
  const sumSince = (start: Date) =>
    sql`coalesce(sum(${usageEvents.costUsd}) filter (where ${usageEvents.occurredAt} >= ${start.toISOString()}::timestamptz), 0)::numeric(14, 6)`;
  const asText = (amount: ReturnType<typeof sumSince>) =>
    sql<string>`${amount}::text`;

  const monthSum = sumSince(windows.month);
  const rows = await db
    .select({
      id: projects.id,
      name: projects.name,
      slug: projects.slug,
      today: asText(sumSince(windows.today)),
      month: asText(monthSum),
      last30Days: asText(sumSince(windows.last30Days)),
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
    .groupBy(sql`rollup((${projects.id}, ${projects.name}, ${projects.slug}))`)
    // Order by the numeric sum; ordering the text form would put "10" before "9".
    .orderBy(desc(monthSum), asc(projects.name));

  const zero = {
    today: "0.000000",
    month: "0.000000",
    last30Days: "0.000000",
    events: 0,
  };
  const strip = ({ today, month, last30Days, events }: SpendTotals) => ({
    today,
    month,
    last30Days,
    events,
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
        ...strip(row),
      })),
  };
}
