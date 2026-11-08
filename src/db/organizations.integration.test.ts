import "dotenv/config";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { parseEnv } from "@/lib/env";
import { createUser } from "./auth";
import {
  createOrganization,
  findOrganization,
  listOrganizations,
  setUserOrganization,
} from "./organizations";
import {
  DEFAULT_ORGANIZATION_ID,
  organizations,
  projects,
  users,
} from "./schema";

// Runs against the database in DATABASE_URL after `npm run db:migrate`.
const client = postgres(parseEnv().DATABASE_URL, {
  max: 1,
  onnotice: () => {},
});
const db = drizzle(client);

const projectIds: string[] = [];
const organizationIds: string[] = [];

afterAll(async () => {
  if (projectIds.length > 0) {
    await db.delete(projects).where(inArray(projects.id, projectIds));
  }
  if (organizationIds.length > 0) {
    await db
      .delete(organizations)
      .where(inArray(organizations.id, organizationIds));
  }
  await client.end();
});

const slug = () => `it-${randomUUID()}`;

async function newOrganization() {
  const [organization] = await db
    .insert(organizations)
    .values({ name: "Org test", slug: slug() })
    .returning();
  organizationIds.push(organization.id);
  return organization;
}

describe("organizations", () => {
  it("has the default organization the migration created", async () => {
    const [row] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, DEFAULT_ORGANIZATION_ID));
    expect(row).toMatchObject({ name: "Default", slug: "default" });
  });

  it("puts new projects and accounts in the default organization", async () => {
    const [project] = await db
      .insert(projects)
      .values({ name: "Org test", slug: slug() })
      .returning();
    projectIds.push(project.id);
    expect(project.organizationId).toBe(DEFAULT_ORGANIZATION_ID);

    const created = await createUser(db, {
      email: `org-${randomUUID()}@example.com`,
      password: "a long test password",
    });
    if (!created.ok) throw new Error("expected a user");
    const [user] = await db
      .select({ organizationId: users.organizationId })
      .from(users)
      .where(eq(users.id, created.user.id));
    await db.delete(users).where(eq(users.id, created.user.id));
    expect(user.organizationId).toBe(DEFAULT_ORGANIZATION_ID);
  });

  it("refuses a project in an organization that doesn't exist", async () => {
    await expect(
      db.insert(projects).values({
        name: "Org test",
        slug: slug(),
        organizationId: randomUUID(),
      }),
    ).rejects.toThrow();
  });

  it("refuses to delete an organization that still has projects", async () => {
    const organization = await newOrganization();
    const [project] = await db
      .insert(projects)
      .values({
        name: "Org test",
        slug: slug(),
        organizationId: organization.id,
      })
      .returning();
    projectIds.push(project.id);
    await expect(
      db.delete(organizations).where(eq(organizations.id, organization.id)),
    ).rejects.toThrow();
  });

  it("keeps organization slugs unique", async () => {
    const organization = await newOrganization();
    await expect(
      db
        .insert(organizations)
        .values({ name: "Another", slug: organization.slug }),
    ).rejects.toThrow();
  });
});

describe("managing organizations", () => {
  it("creates one, and reports a taken slug", async () => {
    const orgSlug = slug();
    const created = await createOrganization(db, {
      name: "Acme",
      slug: orgSlug,
    });
    if (!created.ok) throw new Error("expected an organization");
    organizationIds.push(created.organization.id);
    expect(await findOrganization(db, orgSlug)).toMatchObject({ name: "Acme" });
    expect(
      await createOrganization(db, { name: "Other", slug: orgSlug }),
    ).toEqual({ ok: false, error: "slug_taken" });
  });

  it("is undefined for an unknown slug", async () => {
    expect(await findOrganization(db, slug())).toBeUndefined();
  });

  it("creates an account in an organization and moves it", async () => {
    const organization = await newOrganization();
    const email = `org-${randomUUID()}@example.com`;
    const created = await createUser(db, {
      email,
      password: "a long test password",
      organizationId: organization.id,
    });
    if (!created.ok) throw new Error("expected a user");
    expect(created.user.organizationId).toBe(organization.id);

    const listed = (await listOrganizations(db)).find(
      (row) => row.slug === organization.slug,
    );
    expect(listed).toMatchObject({ accounts: 1, projects: 0 });

    expect(
      await setUserOrganization(db, {
        email: email.toUpperCase(),
        organization: { id: DEFAULT_ORGANIZATION_ID, slug: "default" },
      }),
    ).toEqual({
      ok: true,
      email,
      previous: organization.slug,
      current: "default",
    });
    await db.delete(users).where(eq(users.id, created.user.id));
  });

  it("reports an unknown email when moving", async () => {
    expect(
      await setUserOrganization(db, {
        email: `missing-${randomUUID()}@example.com`,
        organization: { id: DEFAULT_ORGANIZATION_ID, slug: "default" },
      }),
    ).toEqual({ ok: false, error: "user_not_found" });
  });
});
