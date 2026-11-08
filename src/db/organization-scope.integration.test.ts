import "dotenv/config";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { projectCreatedEntry } from "@/lib/audit";
import { parseEnv } from "@/lib/env";
import { getSpendByAttribution } from "./attribution-spend";
import { audited, listAuditEntries } from "./audit";
import { focusCsv } from "./focus-export";
import { listOutcomeNames, outcomeCountsByAttribution } from "./outcomes";
import { getProject, listProjects, updateProject } from "./projects";
import {
  auditLog,
  organizations,
  outcomes,
  projects,
  usageEvents,
} from "./schema";
import { ALL_ORGANIZATIONS, type OrganizationScope } from "./scope";
import { getSpendOverview } from "./spend";
import { getDailySpend, getSpendBreakdown } from "./spend-series";
import { listUsageEvents, listUsageModels } from "./usage-events";
import { usageCsv } from "./usage-export";

// Runs against the database in DATABASE_URL after `npm run db:migrate`.
const client = postgres(parseEnv().DATABASE_URL, {
  max: 1,
  onnotice: () => {},
});
const db = drizzle(client);

const run = randomUUID();
const start = new Date(Date.now() - 24 * 60 * 60 * 1000);
const organizationIds: string[] = [];

interface Team {
  scope: OrganizationScope;
  projectId: string;
  name: string;
  model: string;
  feature: string;
  outcome: string;
}
let mine: Team;
let theirs: Team;

async function team(label: string): Promise<Team> {
  const [organization] = await db
    .insert(organizations)
    .values({ name: label, slug: `it-${label}-${run}` })
    .returning();
  organizationIds.push(organization.id);
  const name = `Scope ${label} ${run}`;
  const model = `scope-${label}-${run}`;
  const feature = `feature-${label}-${run}`;
  const outcome = `outcome-${label}-${run}`;
  const [project] = await db
    .insert(projects)
    .values({
      name,
      slug: `it-${label}-${randomUUID()}`,
      organizationId: organization.id,
    })
    .returning();
  await db.insert(usageEvents).values({
    projectId: project.id,
    provider: "openai",
    model,
    costUsd: "1.000000",
    feature,
    occurredAt: new Date(),
  });
  await db.insert(outcomes).values({
    projectId: project.id,
    name: outcome,
    feature,
  });
  await audited(
    db,
    { userId: null, label, organizationId: organization.id },
    async () => ({ result: null, entry: projectCreatedEntry(project) }),
  );
  return {
    scope: { organizationId: organization.id },
    projectId: project.id,
    name,
    model,
    feature,
    outcome,
  };
}

async function collect(chunks: AsyncGenerator<string>) {
  let text = "";
  for await (const chunk of chunks) text += chunk;
  return text;
}

beforeAll(async () => {
  mine = await team("mine");
  theirs = await team("theirs");
});

afterAll(async () => {
  await db
    .delete(auditLog)
    .where(inArray(auditLog.organizationId, organizationIds));
  await db
    .delete(projects)
    .where(inArray(projects.organizationId, organizationIds));
  await db
    .delete(organizations)
    .where(inArray(organizations.id, organizationIds));
  await client.end();
});

describe("organization scope", () => {
  it("limits the spend overview, totals included", async () => {
    const overview = await getSpendOverview(db, mine.scope);
    expect(overview.projects.map((p) => p.id)).toEqual([mine.projectId]);
    expect(overview.totals.events).toBe(1);
  });

  it("lists only the organization's projects", async () => {
    expect((await listProjects(db, mine.scope)).map((p) => p.id)).toEqual([
      mine.projectId,
    ]);
  });

  it("treats another organization's project as missing", async () => {
    expect(await getProject(db, mine.scope, theirs.projectId)).toBeUndefined();
    expect(await getProject(db, mine.scope, mine.projectId)).toBeDefined();
  });

  it("refuses to update another organization's project", async () => {
    expect(
      await updateProject(db, mine.scope, theirs.projectId, {
        name: "Taken over",
        slug: `it-${randomUUID()}`,
        monthlyBudgetUsd: null,
        runBudgetUsd: null,
      }),
    ).toEqual({ ok: false, error: "not_found" });
    expect((await getProject(db, theirs.scope, theirs.projectId))?.name).toBe(
      theirs.name,
    );
  });

  it("limits daily spend and the provider breakdown", async () => {
    const daily = await getDailySpend(db, mine.scope, { start });
    expect(daily.map((d) => Number(d.costUsd))).toEqual([1]);
    const { byModel } = await getSpendBreakdown(db, mine.scope, { start });
    expect(byModel.map((row) => row.model)).toEqual([mine.model]);
  });

  it("returns nothing when filtering by another organization's project", async () => {
    const filter = { start, projectId: theirs.projectId };
    expect(await getDailySpend(db, mine.scope, filter)).toEqual([]);
    expect(
      (await listUsageEvents(db, mine.scope, { projectId: theirs.projectId }))
        .rows,
    ).toEqual([]);
    expect(await listOutcomeNames(db, mine.scope, filter)).toEqual([]);
  });

  it("limits the attribution breakdown", async () => {
    const { top } = await getSpendByAttribution(db, mine.scope, {
      key: "feature",
      start,
      limit: 10,
    });
    expect(top.map((group) => group.value)).toEqual([mine.feature]);
  });

  it("limits usage events and the model filter", async () => {
    const { rows } = await listUsageEvents(db, mine.scope, {});
    expect(rows.map((row) => row.projectId)).toEqual([mine.projectId]);
    expect(await listUsageModels(db, mine.scope)).toEqual([mine.model]);
  });

  it("limits both CSV exports", async () => {
    const usage = await collect(usageCsv(db, mine.scope, {}));
    expect(usage).toContain(mine.model);
    expect(usage).not.toContain(theirs.model);
    expect(await collect(focusCsv(db, mine.scope, {}))).not.toContain(
      theirs.model,
    );
  });

  it("limits outcomes", async () => {
    expect(await listOutcomeNames(db, mine.scope, { start })).toEqual([
      mine.outcome,
    ]);
    const counts = await outcomeCountsByAttribution(db, mine.scope, {
      key: "feature",
      name: theirs.outcome,
      start,
    });
    expect(counts.total).toBe(0);
  });

  it("limits the audit log", async () => {
    const { entries } = await listAuditEntries(db, mine.scope, 1);
    expect(entries.map((e) => e.actorLabel)).toEqual(["mine"]);
  });

  it("reads everything for code acting for no one", async () => {
    const ids = (await listProjects(db, ALL_ORGANIZATIONS)).map((p) => p.id);
    expect(ids).toEqual(
      expect.arrayContaining([mine.projectId, theirs.projectId]),
    );
  });
});
