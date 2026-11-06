import "dotenv/config";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseEnv } from "@/lib/env";
import { projects, usageEvents } from "./schema";
import { USAGE_CSV_COLUMNS, usageCsv } from "./usage-export";

// Runs against the database in DATABASE_URL after `npm run db:migrate`.
const client = postgres(parseEnv().DATABASE_URL, {
  max: 1,
  onnotice: () => {},
});
const db = drizzle(client);

// A project and a day of its own.
const day = { from: "2038-04-01", to: "2038-04-01" };
let projectId: string;

beforeAll(async () => {
  const [project] = await db
    .insert(projects)
    .values({ name: "Export, Inc.", slug: `it-${randomUUID()}` })
    .returning({ id: projects.id });
  projectId = project.id;
  await db.insert(usageEvents).values(
    Array.from({ length: 7 }, (_, i) => ({
      projectId,
      provider: "anthropic" as const,
      model: "claude-haiku-5-5",
      inputTokens: 1000 + i,
      cachedInputTokens: 100,
      cacheWriteInputTokens: 50,
      outputTokens: 10,
      costUsd: `0.00000${i}`,
      requestId: `exp-${i}`,
      customerId: i === 0 ? "=cmd|' /C calc'!A0" : `cus_${i % 2}`,
      feature: "chat",
      tags: i === 6 ? { env: "prod", team: "search" } : null,
      occurredAt: new Date(`2038-04-01T0${i}:00:00Z`),
    })),
  );
});

afterAll(async () => {
  await db.delete(projects).where(eq(projects.id, projectId));
  await client.end();
});

async function exportText(filters: Record<string, string>, pageSize = 3) {
  let text = "";
  for await (const chunk of usageCsv(db, { projectId, ...filters }, pageSize))
    text += chunk;
  return text;
}

describe("usageCsv", () => {
  it("exports every matching event across pages, newest first", async () => {
    const lines = (await exportText(day)).trimEnd().split("\r\n");
    expect(lines[0]).toBe(USAGE_CSV_COLUMNS.join(","));
    // 7 events with a page size of 3: three queries, no row lost or repeated.
    const ids = lines.slice(1).map((line) => line.split(",").at(-1));
    expect(ids).toEqual([
      "exp-6",
      "exp-5",
      "exp-4",
      "exp-3",
      "exp-2",
      "exp-1",
      "exp-0",
    ]);
  });

  it("writes exact costs, cache writes, quoted names and attribution", async () => {
    const lines = (await exportText(day)).trimEnd().split("\r\n");
    expect(lines[1]).toBe(
      '2038-04-01T06:00:00.000Z,"Export, Inc.",anthropic,claude-haiku-5-5,1006,100,50,0,standard,10,0.000006,cus_0,,chat,,"{""env"":""prod"",""team"":""search""}",exp-6',
    );
  });

  it("neutralizes a caller-supplied formula", async () => {
    const lines = (await exportText(day)).trimEnd().split("\r\n");
    expect(lines.at(-1)).toContain(`'=cmd|' /C calc'!A0`);
    expect(lines.at(-1)).not.toMatch(/,=cmd/);
  });

  it("applies the usage page's filters", async () => {
    const text = await exportText({ ...day, customerId: "cus_1" });
    const lines = text.trimEnd().split("\r\n");
    expect(lines.slice(1).map((l) => l.split(",").at(-1))).toEqual([
      "exp-5",
      "exp-3",
      "exp-1",
    ]);
  });

  it("is just the header when nothing matches", async () => {
    expect(await exportText({ from: "2099-01-01", to: "2099-01-01" })).toBe(
      `${USAGE_CSV_COLUMNS.join(",")}\r\n`,
    );
  });
});
