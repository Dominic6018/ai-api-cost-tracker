import "dotenv/config";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { parseEnv } from "@/lib/env";
import { createUser } from "./auth";
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
