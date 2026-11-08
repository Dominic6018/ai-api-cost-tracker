import "dotenv/config";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { projectCreatedEntry, projectUpdatedEntry } from "@/lib/audit";
import { parseEnv } from "@/lib/env";
import { audited, COMMAND_LINE, listAuditEntries, userActor } from "./audit";
import { createUser } from "./auth";
import { endModelPrice } from "./pricing";
import { createProject, getProject, updateProject } from "./projects";
import { auditLog, DEFAULT_ORGANIZATION_ID, projects, users } from "./schema";
import { ALL_ORGANIZATIONS } from "./scope";

// Runs against the database in DATABASE_URL after `npm run db:migrate`.
const client = postgres(parseEnv().DATABASE_URL, {
  max: 1,
  onnotice: () => {},
});
const db = drizzle(client);

const slugs: string[] = [];

afterAll(async () => {
  if (slugs.length > 0) {
    await db.delete(auditLog).where(inArray(auditLog.target, slugs));
    await db.delete(projects).where(inArray(projects.slug, slugs));
  }
  await client.end();
});

const values = (slug: string) => ({
  name: "Audit test",
  slug,
  monthlyBudgetUsd: "100.00",
  runBudgetUsd: null,
});

const newSlug = () => {
  const slug = `it-${randomUUID()}`;
  slugs.push(slug);
  return slug;
};

const auditedCreate = (
  slug: string,
  actor: Parameters<typeof audited>[1] = COMMAND_LINE,
) =>
  audited(db, actor, async (tx) => {
    const result = await createProject(tx, values(slug));
    return {
      result,
      entry: result.ok ? projectCreatedEntry(result.project) : null,
    };
  });

const entriesFor = (slug: string) =>
  db.select().from(auditLog).where(eq(auditLog.target, slug));

describe("audited", () => {
  it("saves a change and its entry together", async () => {
    const slug = newSlug();
    const result = await auditedCreate(slug);
    expect(result.ok).toBe(true);
    expect(await entriesFor(slug)).toMatchObject([
      {
        action: "project.created",
        actorUserId: null,
        actorLabel: "command line",
      },
    ]);
  });

  it("records nothing for a refused change", async () => {
    const slug = newSlug();
    await auditedCreate(slug);
    expect(await auditedCreate(slug)).toEqual({
      ok: false,
      error: "slug_taken",
    });
    expect(await entriesFor(slug)).toHaveLength(1);
  });

  it("reports a duplicate slug on update, keeping the transaction", async () => {
    const taken = newSlug();
    await auditedCreate(taken);
    const other = newSlug();
    const created = await auditedCreate(other);
    if (!created.ok) throw new Error("expected a project");
    expect(
      await audited(db, COMMAND_LINE, async (tx) => ({
        result: await updateProject(
          tx,
          ALL_ORGANIZATIONS,
          created.project.id,
          values(taken),
        ),
        entry: null,
      })),
    ).toEqual({ ok: false, error: "slug_taken" });
  });

  it("reports a malformed id instead of aborting", async () => {
    expect(
      await audited(db, COMMAND_LINE, async (tx) => ({
        result: await getProject(tx, ALL_ORGANIZATIONS, "not-a-uuid"),
        entry: null,
      })),
    ).toBeUndefined();
    expect(
      await audited(db, COMMAND_LINE, async (tx) => ({
        result: await updateProject(
          tx,
          ALL_ORGANIZATIONS,
          "not-a-uuid",
          values(newSlug()),
        ),
        entry: null,
      })),
    ).toEqual({ ok: false, error: "not_found" });
    expect(
      await audited(db, COMMAND_LINE, async (tx) => ({
        result: await endModelPrice(
          tx,
          "not-a-uuid",
          {
            endsAt: new Date("2026-12-01T00:00:00Z"),
            sourceUrl: "https://example.com/pricing",
            checkedOn: "2026-11-08",
          },
          randomUUID(),
        ),
        entry: null,
      })),
    ).toEqual({ ok: false, error: "not_found" });
  });

  it("reports a taken email instead of aborting", async () => {
    const email = `audit-${randomUUID()}@example.com`;
    const input = { email, password: "a long test password" };
    const first = await audited(db, COMMAND_LINE, async (tx) => ({
      result: await createUser(tx, input),
      entry: null,
    }));
    if (!first.ok) throw new Error("expected a user");
    expect(
      await audited(db, COMMAND_LINE, async (tx) => ({
        result: await createUser(tx, input),
        entry: null,
      })),
    ).toEqual({ ok: false, error: "email_taken" });
    await db.delete(users).where(eq(users.id, first.user.id));
  });

  it("undoes the change when the entry can't be saved", async () => {
    const slug = newSlug();
    await expect(
      auditedCreate(slug, {
        userId: randomUUID(),
        label: "no such user",
        organizationId: DEFAULT_ORGANIZATION_ID,
      }),
    ).rejects.toThrow();
    const rows = await db
      .select()
      .from(projects)
      .where(eq(projects.slug, slug));
    expect(rows).toHaveLength(0);
  });

  it("records what an update changed, and nothing for no change", async () => {
    const slug = newSlug();
    const created = await auditedCreate(slug);
    if (!created.ok) throw new Error("expected a project");
    const update = (monthlyBudgetUsd: string | null) =>
      audited(db, COMMAND_LINE, async (tx) => {
        const before = await getProject(
          tx,
          ALL_ORGANIZATIONS,
          created.project.id,
        );
        const result = await updateProject(
          tx,
          ALL_ORGANIZATIONS,
          created.project.id,
          {
            ...values(slug),
            monthlyBudgetUsd,
          },
        );
        return {
          result,
          entry:
            before && result.ok
              ? projectUpdatedEntry(before, result.project)
              : null,
        };
      });

    await update("100");
    expect(await entriesFor(slug)).toHaveLength(1);

    await update(null);
    const entries = await entriesFor(slug);
    expect(entries).toHaveLength(2);
    expect(entries.find((e) => e.action === "project.updated")).toMatchObject({
      details: { monthlyBudgetUsd: { from: "100.00", to: null } },
    });
  });

  it("keeps the actor's name after the account is deleted", async () => {
    const created = await createUser(db, {
      email: `audit-${randomUUID()}@example.com`,
      password: "a long test password",
    });
    if (!created.ok) throw new Error("expected a user");
    const slug = newSlug();
    await auditedCreate(slug, userActor(created.user));
    await db.delete(users).where(eq(users.id, created.user.id));
    expect(await entriesFor(slug)).toMatchObject([
      { actorUserId: null, actorLabel: created.user.email },
    ]);
  });
});

describe("listAuditEntries", () => {
  it("lists the newest first", async () => {
    const first = newSlug();
    const second = newSlug();
    await auditedCreate(first);
    await auditedCreate(second);
    const { entries } = await listAuditEntries(db, ALL_ORGANIZATIONS, 1);
    const targets = entries.map((e) => e.target);
    expect(targets.indexOf(second)).toBeLessThan(targets.indexOf(first));
    expect(targets.indexOf(first)).toBeGreaterThanOrEqual(0);
  });
});
