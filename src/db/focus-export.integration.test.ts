import "dotenv/config";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseEnv } from "@/lib/env";
import { FOCUS_COLUMNS } from "@/lib/focus";
import { focusCsv } from "./focus-export";
import { modelPricing, projects, usageEvents } from "./schema";

// Runs against the database in DATABASE_URL after `npm run db:migrate`.
const client = postgres(parseEnv().DATABASE_URL, {
  max: 1,
  onnotice: () => {},
});
const db = drizzle(client);

const model = `it-focus-${randomUUID()}`;
const day = { from: "2039-02-01", to: "2039-02-02" };
let projectId: string;
let oldPriceId: string;
let newPriceId: string;

/** A minimal RFC 4180 parser, enough for quoted JSON in Tags. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\r" && text[i + 1] === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      i++;
    } else cell += c;
  }
  return rows;
}

beforeAll(async () => {
  const [project] = await db
    .insert(projects)
    .values({ name: "FOCUS test", slug: `it-${randomUUID()}` })
    .returning({ id: projects.id });
  projectId = project.id;
  const prices = await db
    .insert(modelPricing)
    .values([
      {
        provider: "openai",
        model,
        inputPerMTokUsd: "2",
        outputPerMTokUsd: "8",
        effectiveFrom: new Date("2039-01-01T00:00:00Z"),
        effectiveTo: new Date("2039-02-02T00:00:00Z"),
      },
      {
        provider: "openai",
        model,
        inputPerMTokUsd: "1",
        outputPerMTokUsd: "4",
        effectiveFrom: new Date("2039-02-02T00:00:00Z"),
      },
    ])
    .returning({ id: modelPricing.id });
  [oldPriceId, newPriceId] = prices.map((p) => p.id);

  const event = (occurredAt: string, extra: Record<string, unknown> = {}) => ({
    projectId,
    provider: "openai" as const,
    model,
    inputTokens: 1000,
    outputTokens: 500,
    costUsd: "0.006000",
    occurredAt: new Date(occurredAt),
    ...extra,
  });
  await db.insert(usageEvents).values([
    event("2039-02-01T10:30:00Z", {
      requestId: "focus-old",
      customerId: "cus_42",
      feature: "chat",
    }),
    event("2039-02-02T09:15:00Z", {
      requestId: "focus-new",
      costUsd: "0.003000",
    }),
  ]);
});

afterAll(async () => {
  await db.delete(projects).where(eq(projects.id, projectId));
  await db
    .delete(modelPricing)
    .where(inArray(modelPricing.id, [oldPriceId, newPriceId]));
  await client.end();
});

async function exportRows(filters: Record<string, string> = {}) {
  let text = "";
  for await (const chunk of focusCsv(db, { projectId, ...day, ...filters }, 1))
    text += chunk;
  const [header, ...rows] = parseCsv(text);
  return {
    header,
    rows: rows.map((row) =>
      Object.fromEntries(header.map((column, i) => [column, row[i]])),
    ),
  };
}

describe("focusCsv", () => {
  it("writes the FOCUS header and one row per token type and event", async () => {
    const { header, rows } = await exportRows();
    expect(header).toEqual([...FOCUS_COLUMNS]);
    expect(rows.map((r) => [r.x_RequestId, r.SkuMeter])).toEqual([
      ["focus-new", "Input Tokens"],
      ["focus-new", "Output Tokens"],
      ["focus-old", "Input Tokens"],
      ["focus-old", "Output Tokens"],
    ]);
  });

  it("prices each event at the rate in effect when it occurred", async () => {
    const { rows } = await exportRows();
    const byRequest = (id: string) => rows.filter((r) => r.x_RequestId === id);
    // Old price: 1,000 input at $2 and 500 output at $8 per 1M = $0.006.
    expect(byRequest("focus-old").map((r) => r.ListCost)).toEqual([
      "0.002",
      "0.004",
    ]);
    expect(byRequest("focus-old")[0].SkuPriceId).toBe(`${oldPriceId}/input`);
    // New price from 2 February: half the rates, $0.003.
    expect(byRequest("focus-new").map((r) => r.ListCost)).toEqual([
      "0.001",
      "0.002",
    ]);
    expect(byRequest("focus-new")[0].SkuPriceId).toBe(`${newPriceId}/input`);
    for (const row of rows) {
      expect([row.BilledCost, row.EffectiveCost]).toEqual(["0", "0"]);
    }
  });

  it("round-trips attribution as JSON in Tags and the project as sub account", async () => {
    const { rows } = await exportRows({ customerId: "cus_42" });
    expect(rows).toHaveLength(2);
    expect(JSON.parse(rows[0].Tags)).toEqual({
      customerId: "cus_42",
      feature: "chat",
    });
    expect(rows[0]).toMatchObject({
      SubAccountId: projectId,
      SubAccountName: "FOCUS test",
      ChargePeriodStart: "2039-02-01T10:00:00Z",
      ChargePeriodEnd: "2039-02-01T11:00:00Z",
      BillingPeriodStart: "2039-02-01T00:00:00Z",
      BillingPeriodEnd: "2039-03-01T00:00:00Z",
    });
  });

  it("leaves out events with no price in effect", async () => {
    await db.insert(usageEvents).values({
      projectId,
      provider: "openai",
      model,
      inputTokens: 10,
      outputTokens: 10,
      costUsd: "0.000100",
      requestId: "focus-unpriced",
      // Before the first price row.
      occurredAt: new Date("2038-12-31T23:00:00Z"),
    });
    const { rows } = await exportRows({ from: "2038-12-31", to: "2039-02-02" });
    expect(rows.some((r) => r.x_RequestId === "focus-unpriced")).toBe(false);
    expect(rows).toHaveLength(4);
  });
});
