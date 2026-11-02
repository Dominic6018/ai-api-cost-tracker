import "dotenv/config";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { fetchAnthropicCostReport } from "@/lib/anthropic-cost-report";
import { parseEnv } from "@/lib/env";
import {
  formatMicros,
  parseAnthropicCostReport,
  reconcile,
  type BilledCost,
} from "@/lib/reconcile";
import { recordedDailyCost } from "../reconcile";

const USAGE = `Usage:
  npm run reconcile -- --provider anthropic --from <YYYY-MM-DD> [--to <YYYY-MM-DD>]

Compares the costs recorded here with what the provider billed, per UTC day
and model. --to is exclusive and defaults to tomorrow, so today is included.

Options:
  --tolerance <percent>   Flag differences above this share of the billed
                          amount (default 2); differences under $0.01 never are
  --report-file <path>    Read a saved cost report (one page of JSON, or an
                          array of pages) instead of calling the API

Environment:
  ANTHROPIC_ADMIN_KEY     An Admin API key (sk-ant-admin...), to fetch the report`;

const DAY_MS = 24 * 60 * 60 * 1000;

function parseDay(value: string, name: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`--${name} must be a date like 2026-11-01.\n\n${USAGE}`);
  }
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()))
    throw new Error(`Invalid --${name}: ${value}`);
  return date;
}

async function billedFromFile(path: string): Promise<BilledCost[]> {
  const json: unknown = JSON.parse(await readFile(path, "utf8"));
  const pages = Array.isArray(json) ? json : [json];
  return pages.flatMap((page) => parseAnthropicCostReport(page).costs);
}

// Reads recorded costs from the database in DATABASE_URL; never writes.
async function main() {
  const { values } = parseArgs({
    options: {
      provider: { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
      tolerance: { type: "string" },
      "report-file": { type: "string" },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  if (values.provider !== "anthropic") {
    throw new Error(
      `Only --provider anthropic is supported so far.\n\n${USAGE}`,
    );
  }
  if (!values.from) throw new Error(USAGE);
  const from = parseDay(values.from, "from");
  const to = values.to
    ? parseDay(values.to, "to")
    : new Date(Math.floor(Date.now() / DAY_MS) * DAY_MS + DAY_MS);
  if (to <= from) throw new Error("--to must be after --from.");
  const tolerance =
    values.tolerance === undefined ? 2 : Number(values.tolerance);
  if (!Number.isFinite(tolerance) || tolerance < 0) {
    throw new Error("--tolerance must be a non-negative number.");
  }

  let billed: BilledCost[];
  if (values["report-file"]) {
    billed = await billedFromFile(values["report-file"]);
  } else {
    const adminKey = process.env.ANTHROPIC_ADMIN_KEY;
    if (!adminKey) {
      throw new Error(
        "Set ANTHROPIC_ADMIN_KEY to an Admin API key, or pass --report-file.",
      );
    }
    billed = await fetchAnthropicCostReport({ adminKey, from, to });
  }
  // A saved report may cover more days than asked for.
  const fromDay = from.toISOString().slice(0, 10);
  const toDay = to.toISOString().slice(0, 10);
  billed = billed.filter((cost) => cost.day >= fromDay && cost.day < toDay);

  const client = postgres(parseEnv().DATABASE_URL, {
    max: 1,
    onnotice: () => {},
  });
  try {
    const recorded = await recordedDailyCost(drizzle(client), {
      provider: "anthropic",
      from,
      to,
    });
    const report = reconcile(billed, recorded, tolerance);

    console.log(
      `Anthropic, ${fromDay} to ${toDay} (exclusive), all projects. Diff = recorded - billed.\n`,
    );
    const table = report.rows.map((row) => ({
      day: row.day,
      model: row.model,
      billed: formatMicros(row.billedMicros),
      recorded: formatMicros(row.recordedMicros),
      diff: formatMicros(row.diffMicros),
      "": row.flagged ? "CHECK" : "",
    }));
    if (table.length > 0) console.table(table);
    else console.log("No Anthropic token costs billed or recorded.");
    for (const other of report.otherCosts) {
      console.log(
        `Billed but not tracked (${other.costType}): ${formatMicros(other.micros)}`,
      );
    }
    const { billedMicros, recordedMicros, diffMicros } = report.totals;
    const flagged = report.rows.filter((row) => row.flagged).length;
    console.log(
      `\nTotal token costs: billed ${formatMicros(billedMicros)}, recorded ${formatMicros(recordedMicros)}, diff ${formatMicros(diffMicros)}.` +
        `\n${flagged} of ${report.rows.length} day/model row(s) differ by more than ${tolerance}% (and at least $0.01).`,
    );
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
