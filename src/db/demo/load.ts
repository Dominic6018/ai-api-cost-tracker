import { and, eq, like } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import {
  DEFAULT_ORGANIZATION_ID,
  outcomes,
  projects,
  usageEvents,
} from "../schema";
import { DEMO_SLUG_PREFIX, type DemoData } from "./generate";

/** Any Drizzle Postgres database, so the CLI and tests can pass their own. */
type Database = Pick<PgDatabase<PgQueryResultHKT>, "transaction">;

const INSERT_BATCH = 1_000;

/**
 * Demo projects live in the default organization and are found by slug
 * prefix there, so another organization's "demo-..." project is never
 * touched. Deleting them cascades to their events.
 */
const isDemoProject = and(
  eq(projects.organizationId, DEFAULT_ORGANIZATION_ID),
  like(projects.slug, `${DEMO_SLUG_PREFIX}%`),
);

/**
 * Replaces any existing demo data with `data` in one transaction, so a
 * re-run never duplicates rows and a failure leaves the old data intact.
 */
export async function loadDemoData(
  db: Database,
  data: DemoData,
): Promise<{ projects: number; events: number }> {
  return db.transaction(async (tx) => {
    await tx.delete(projects).where(isDemoProject);

    const created = await tx
      .insert(projects)
      .values(
        data.projects.map((p) => ({
          ...p,
          organizationId: DEFAULT_ORGANIZATION_ID,
        })),
      )
      .returning({ id: projects.id, slug: projects.slug });
    const idBySlug = new Map(created.map((p) => [p.slug, p.id]));

    for (let i = 0; i < data.events.length; i += INSERT_BATCH) {
      await tx.insert(usageEvents).values(
        data.events
          .slice(i, i + INSERT_BATCH)
          .map(({ projectSlug, ...event }) => {
            const projectId = idBySlug.get(projectSlug);
            if (!projectId)
              throw new Error(`Unknown demo project ${projectSlug}`);
            return { ...event, projectId, metadata: { demo: true } };
          }),
      );
    }
    for (let i = 0; i < data.outcomes.length; i += INSERT_BATCH) {
      await tx.insert(outcomes).values(
        data.outcomes
          .slice(i, i + INSERT_BATCH)
          .map(({ projectSlug, ...outcome }) => {
            const projectId = idBySlug.get(projectSlug);
            if (!projectId)
              throw new Error(`Unknown demo project ${projectSlug}`);
            return { ...outcome, projectId };
          }),
      );
    }
    return { projects: created.length, events: data.events.length };
  });
}

/** Deletes every demo project and, by cascade, its usage, outcomes and API keys. */
export async function removeDemoData(db: Database): Promise<number> {
  return db.transaction(async (tx) => {
    const removed = await tx
      .delete(projects)
      .where(isDemoProject)
      .returning({ id: projects.id });
    return removed.length;
  });
}
