import { and, asc, eq, gte, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { AttributionKey } from "@/lib/attribution";
import type { OutcomeInput } from "@/lib/outcomes";
import { outcomes, type Outcome } from "./schema";
import { projectInOrganization, type OrganizationScope } from "./scope";

/** Any Drizzle Postgres database, so callers and tests can pass their own. */
type Database = Pick<
  PgDatabase<PgQueryResultHKT>,
  "select" | "selectDistinct" | "insert"
>;

const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";

function pgErrorCode(error: unknown): string | undefined {
  const cause = (error as { cause?: unknown })?.cause ?? error;
  const code = (cause as { code?: unknown })?.code;
  return typeof code === "string" ? code : undefined;
}

export type RecordOutcomeResult =
  | { ok: true; outcome: Outcome; replayed: boolean }
  | { ok: false; error: "project_not_found" | "outcome_id_conflict" };

async function findByOutcomeId(
  db: Database,
  projectId: string,
  outcomeId: string,
) {
  const [row] = await db
    .select()
    .from(outcomes)
    .where(
      and(eq(outcomes.projectId, projectId), eq(outcomes.outcomeId, outcomeId)),
    );
  return row;
}

/** A retry is the same outcome when its name and count match. */
function replay(existing: Outcome, input: OutcomeInput): RecordOutcomeResult {
  return existing.name === input.name && existing.count === input.count
    ? { ok: true, outcome: existing, replayed: true }
    : { ok: false, error: "outcome_id_conflict" };
}

/**
 * Stores an outcome. With an `outcomeId`, a retry returns the stored
 * outcome instead of counting it twice, and different contents conflict.
 */
export async function recordOutcome(
  db: Database,
  input: OutcomeInput,
): Promise<RecordOutcomeResult> {
  if (input.outcomeId !== undefined) {
    const existing = await findByOutcomeId(
      db,
      input.projectId,
      input.outcomeId,
    );
    if (existing) return replay(existing, input);
  }
  try {
    const [outcome] = await db
      .insert(outcomes)
      .values({
        projectId: input.projectId,
        name: input.name,
        count: input.count,
        occurredAt: input.occurredAt,
        outcomeId: input.outcomeId ?? null,
        customerId: input.customerId ?? null,
        userId: input.userId ?? null,
        feature: input.feature ?? null,
        runId: input.runId ?? null,
      })
      .returning();
    return { ok: true, outcome, replayed: false };
  } catch (error) {
    const code = pgErrorCode(error);
    if (code === FOREIGN_KEY_VIOLATION) {
      return { ok: false, error: "project_not_found" };
    }
    // A concurrent retry was inserted first; replay the winner.
    if (code === UNIQUE_VIOLATION && input.outcomeId !== undefined) {
      const existing = await findByOutcomeId(
        db,
        input.projectId,
        input.outcomeId,
      );
      if (existing) return replay(existing, input);
    }
    throw error;
  }
}

const where = (scope: OrganizationScope, start: Date, projectId?: string) =>
  and(
    projectInOrganization(outcomes.projectId, scope),
    gte(outcomes.occurredAt, start),
    projectId ? eq(outcomes.projectId, projectId) : undefined,
  );

/** Outcome names recorded since `start`, for the breakdown's selector. */
export async function listOutcomeNames(
  db: Database,
  scope: OrganizationScope,
  { start, projectId }: { start: Date; projectId?: string },
): Promise<string[]> {
  const rows = await db
    .selectDistinct({ name: outcomes.name })
    .from(outcomes)
    .where(where(scope, start, projectId))
    .orderBy(asc(outcomes.name))
    .limit(100);
  return rows.map((row) => row.name);
}

export interface OutcomeCounts {
  /** Count per attribution value; null is outcomes without one. */
  byValue: Map<string | null, number>;
  total: number;
}

/** One outcome's counts since `start`, grouped by an attribution field. */
export async function outcomeCountsByAttribution(
  db: Database,
  scope: OrganizationScope,
  {
    key,
    name,
    start,
    projectId,
  }: { key: AttributionKey; name: string; start: Date; projectId?: string },
): Promise<OutcomeCounts> {
  const column = outcomes[key];
  const rows = await db
    .select({
      value: column,
      count: sql<string>`sum(${outcomes.count})::text`,
    })
    .from(outcomes)
    .where(and(where(scope, start, projectId), eq(outcomes.name, name)))
    .groupBy(column);
  const byValue = new Map(rows.map((row) => [row.value, Number(row.count)]));
  const total = [...byValue.values()].reduce((sum, n) => sum + n, 0);
  return { byValue, total };
}
