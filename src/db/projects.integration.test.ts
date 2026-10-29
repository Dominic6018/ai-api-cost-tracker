import "dotenv/config";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { parseEnv } from "@/lib/env";
import {
  createProject,
  getProject,
  listProjects,
  updateProject,
} from "./projects";
import { projects } from "./schema";

// Runs against the database in DATABASE_URL after `npm run db:migrate`.
const client = postgres(parseEnv().DATABASE_URL, {
  max: 1,
  onnotice: () => {},
});
const db = drizzle(client);

const createdIds: string[] = [];

afterAll(async () => {
  if (createdIds.length > 0) {
    await db.delete(projects).where(inArray(projects.id, createdIds));
  }
  await client.end();
});

const slug = () => `it-${randomUUID()}`;

async function create(monthlyBudgetUsd: string | null = null) {
  const result = await createProject(db, {
    name: "Projects test",
    slug: slug(),
    monthlyBudgetUsd,
  });
  if (!result.ok) throw new Error(`expected success, got ${result.error}`);
  createdIds.push(result.project.id);
  return result.project;
}

describe("project data access", () => {
  it("creates a project, storing an empty budget as null", async () => {
    const project = await create();
    expect(project.monthlyBudgetUsd).toBeNull();
    expect(await getProject(db, project.id)).toEqual(project);
  });

  it("stores a budget with two decimal places", async () => {
    expect((await create("99.5")).monthlyBudgetUsd).toBe("99.50");
  });

  it("returns slug_taken when creating a duplicate slug", async () => {
    const project = await create();
    expect(
      await createProject(db, {
        name: "Duplicate",
        slug: project.slug,
        monthlyBudgetUsd: null,
      }),
    ).toEqual({ ok: false, error: "slug_taken" });
  });

  it("updates a project and bumps updated_at", async () => {
    const project = await create();
    const result = await updateProject(db, project.id, {
      name: "Renamed",
      slug: project.slug,
      monthlyBudgetUsd: "250",
    });
    if (!result.ok) throw new Error(`expected success, got ${result.error}`);
    expect(result.project.name).toBe("Renamed");
    expect(result.project.monthlyBudgetUsd).toBe("250.00");
    expect(result.project.updatedAt.getTime()).toBeGreaterThanOrEqual(
      project.updatedAt.getTime(),
    );
  });

  it("can clear a budget", async () => {
    const project = await create("10");
    const result = await updateProject(db, project.id, {
      name: project.name,
      slug: project.slug,
      monthlyBudgetUsd: null,
    });
    expect(result.ok && result.project.monthlyBudgetUsd).toBeNull();
  });

  it("returns slug_taken when renaming onto another project's slug", async () => {
    const first = await create();
    const second = await create();
    expect(
      await updateProject(db, second.id, {
        name: second.name,
        slug: first.slug,
        monthlyBudgetUsd: null,
      }),
    ).toEqual({ ok: false, error: "slug_taken" });
  });

  it.each([randomUUID(), "not-a-uuid"])(
    "treats the id %s as not found",
    async (id) => {
      expect(await getProject(db, id)).toBeUndefined();
      expect(
        await updateProject(db, id, {
          name: "x",
          slug: slug(),
          monthlyBudgetUsd: null,
        }),
      ).toEqual({ ok: false, error: "not_found" });
    },
  );

  it("lists projects ordered by name", async () => {
    const project = await create();
    const all = await listProjects(db);
    expect(all.map((p) => p.id)).toContain(project.id);
    const names = all.map((p) => p.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });
});
