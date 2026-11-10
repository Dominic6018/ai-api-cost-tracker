import { and, asc, desc, eq, gte, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { UsageInput } from "@/lib/usage";
import {
  INGESTION_OUTCOMES,
  ingestionCounts,
  projects,
  type IngestionOutcome,
} from "./schema";
import { inOrganization, type OrganizationScope } from "./scope";
import { recordUsage, type RecordUsageResult } from "./usage";

type Database = Pick<
  PgDatabase<PgQueryResultHKT>,
  "select" | "insert" | "update"
>;

/** The UTC day of `now`, as stored, e.g. "2026-11-11". */
const utcDay = (now: Date) => now.toISOString().slice(0, 10);

/**
 * Adds to a project's count of an outcome for today (UTC). Never throws:
 * a counting failure is logged and must not fail the request it counts.
 */
export async function countIngestion(
  db: Pick<Database, "insert">,
  projectId: string,
  outcome: IngestionOutcome,
  n = 1,
  now: Date = new Date(),
): Promise<void> {
  if (n <= 0) return;
  try {
    await db
      .insert(ingestionCounts)
      .values({ projectId, day: utcDay(now), outcome, count: n })
      .onConflictDoUpdate({
        target: [
          ingestionCounts.projectId,
          ingestionCounts.day,
          ingestionCounts.outcome,
        ],
        set: { count: sql`${ingestionCounts.count} + ${n}` },
      });
  } catch (error) {
    console.error("Couldn't count ingestion:", error);
  }
}

/** Which outcome a recording counts as; null when there's no project. */
export function outcomeOf(result: RecordUsageResult): IngestionOutcome | null {
  if (!result.ok) {
    return result.error === "request_id_conflict" ? "conflict" : null;
  }
  if (result.replayed) return "replayed";
  return result.event.pricingStatus === "unpriced" ? "unpriced" : "stored";
}

/** Records usage and counts the outcome, for the ingestion endpoints. */
export async function recordAndCount(
  db: Database,
  usage: UsageInput,
): Promise<RecordUsageResult> {
  const result = await recordUsage(db, usage);
  const outcome = outcomeOf(result);
  if (outcome) await countIngestion(db, usage.projectId, outcome);
  return result;
}

export type IngestionRow = {
  projectId: string;
  projectName: string;
  day: string;
} & Record<IngestionOutcome, number>;

/** Each project's counts per UTC day since `days` ago, newest day first. */
export async function getIngestionHealth(
  db: Pick<Database, "select">,
  scope: OrganizationScope,
  days: number,
  now: Date = new Date(),
): Promise<IngestionRow[]> {
  const since = utcDay(new Date(now.getTime() - (days - 1) * 86_400_000));
  const rows = await db
    .select({
      projectId: ingestionCounts.projectId,
      projectName: projects.name,
      day: ingestionCounts.day,
      outcome: ingestionCounts.outcome,
      count: ingestionCounts.count,
    })
    .from(ingestionCounts)
    .innerJoin(projects, eq(projects.id, ingestionCounts.projectId))
    .where(and(inOrganization(scope), gte(ingestionCounts.day, since)))
    .orderBy(desc(ingestionCounts.day), asc(projects.name));
  const byKey = new Map<string, IngestionRow>();
  for (const row of rows) {
    const key = `${row.day}|${row.projectId}`;
    let entry = byKey.get(key);
    if (!entry) {
      entry = {
        projectId: row.projectId,
        projectName: row.projectName,
        day: row.day,
        ...(Object.fromEntries(INGESTION_OUTCOMES.map((o) => [o, 0])) as Record<
          IngestionOutcome,
          number
        >),
      };
      byKey.set(key, entry);
    }
    entry[row.outcome] = row.count;
  }
  return [...byKey.values()];
}
