import "dotenv/config";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { fetchAnthropicCostReport } from "@/lib/anthropic-cost-report";
import { parseEnv } from "@/lib/env";
import { parseGoogleBilling } from "@/lib/google-billing";
import {
  fetchOpenAICosts,
  parseOpenAICostsPage,
  type OpenAIBilledCost,
} from "@/lib/openai-costs";
import {
  formatMicros,
  parseAnthropicCostReport,
  reconcile,
  type BilledCost,
  type RecordedCost,
} from "@/lib/reconcile";
import { recordedDailyCost } from "../reconcile";

const USAGE = `Usage:
  npm run reconcile -- --provider <anthropic|openai|google> --from <YYYY-MM-DD> [--to <YYYY-MM-DD>]

Compares the costs recorded here with what the provider billed, per UTC day:
per model for Anthropic, and across all models for OpenAI and Google, whose
bills have no model field. --to is exclusive and defaults to tomorrow, so
today is included.

Options:
  --tolerance <percent>   Flag differences above this share of the billed
                          amount (default 2); differences under $0.01 never are
  --report-file <path>    Read a saved report (one page of the provider's
                          JSON, or an array of pages) instead of calling the API.
                          Required for Google: the result of the BigQuery
                          query in the README

Environment:
  ANTHROPIC_ADMIN_KEY     An Anthropic Admin API key (sk-ant-admin...)
  OPENAI_ADMIN_KEY        An OpenAI Admin key (sk-admin-...)`;

const DAY_MS = 24 * 60 * 60 * 1000;
/** OpenAI and Google rows aren't per model; one per day stands for them all. */
const ALL_MODELS = "(all models)";

function parseDay(value: string, name: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`--${name} must be a date like 2026-11-01.\n\n${USAGE}`);
  }
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()))
    throw new Error(`Invalid --${name}: ${value}`);
  return date;
}

async function readPages(path: string): Promise<unknown[]> {
  const json: unknown = JSON.parse(await readFile(path, "utf8"));
  return Array.isArray(json) ? json : [json];
}

function adminKey(name: string): string {
  const key = process.env[name];
  if (!key) {
    throw new Error(`Set ${name} to an Admin key, or pass --report-file.`);
  }
  return key;
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
  const provider = values.provider;
  if (
    provider !== "anthropic" &&
    provider !== "openai" &&
    provider !== "google"
  ) {
    throw new Error(
      `--provider must be anthropic, openai or google.\n\n${USAGE}`,
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
  const reportFile = values["report-file"];
  if (provider === "google" && !reportFile) {
    throw new Error(
      "Google Cloud bills through BigQuery, not an API: save the result of the query in the README and pass it with --report-file.",
    );
  }

  // A saved report may cover more days than asked for.
  const fromDay = from.toISOString().slice(0, 10);
  const toDay = to.toISOString().slice(0, 10);
  const inRange = (cost: { day: string }) =>
    cost.day >= fromDay && cost.day < toDay;

  let billed: BilledCost[];
  let lineItems: OpenAIBilledCost[] = [];
  let creditsMicros = 0n;
  if (provider === "anthropic") {
    billed = (
      reportFile
        ? (await readPages(reportFile)).flatMap(
            (page) => parseAnthropicCostReport(page).costs,
          )
        : await fetchAnthropicCostReport({
            adminKey: adminKey("ANTHROPIC_ADMIN_KEY"),
            from,
            to,
          })
    ).filter(inRange);
  } else if (provider === "google") {
    const days = parseGoogleBilling(
      await readFile(reportFile as string, "utf8"),
    ).filter(inRange);
    billed = days.map((item) => ({
      day: item.day,
      model: ALL_MODELS,
      costType: "tokens",
      micros: item.micros,
    }));
    creditsMicros = days.reduce((sum, d) => sum + d.creditsMicros, 0n);
  } else {
    lineItems = (
      reportFile
        ? (await readPages(reportFile)).flatMap(
            (page) => parseOpenAICostsPage(page).costs,
          )
        : await fetchOpenAICosts({
            adminKey: adminKey("OPENAI_ADMIN_KEY"),
            from,
            to,
          })
    ).filter(inRange);
    billed = lineItems.map((item) => ({
      day: item.day,
      model: ALL_MODELS,
      costType: "tokens",
      micros: item.micros,
    }));
  }

  const client = postgres(parseEnv().DATABASE_URL, {
    max: 1,
    onnotice: () => {},
  });
  try {
    let recorded: RecordedCost[] = await recordedDailyCost(drizzle(client), {
      provider,
      from,
      to,
    });
    if (provider !== "anthropic") {
      // These bills include any web search, so compare in full.
      recorded = recorded.map((cost) => ({
        ...cost,
        model: ALL_MODELS,
        micros: cost.micros + cost.webSearchMicros,
        webSearchMicros: 0n,
      }));
    }
    const report = reconcile(billed, recorded, tolerance);

    const name = {
      anthropic: "Anthropic",
      openai: "OpenAI",
      google: "Google Cloud",
    }[provider];
    console.log(
      `${name}, ${fromDay} to ${toDay} (exclusive), all projects. Diff = recorded - billed.\n`,
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
    else console.log(`No ${name} costs billed or recorded.`);
    const { webSearch } = report;
    if (webSearch.billedMicros !== 0n || webSearch.recordedMicros !== 0n) {
      console.log(
        `Web search: billed ${formatMicros(webSearch.billedMicros)}, recorded ${formatMicros(webSearch.recordedMicros)}, diff ${formatMicros(webSearch.diffMicros)}${webSearch.flagged ? " CHECK" : ""}`,
      );
    }
    for (const other of report.otherCosts) {
      console.log(
        `Billed but not tracked (${other.costType}): ${formatMicros(other.micros)}`,
      );
    }
    if (creditsMicros !== 0n) {
      console.log(
        `Credits applied, not counted as billed: ${formatMicros(creditsMicros)}`,
      );
    }
    if (lineItems.length > 0) {
      // OpenAI bills everything per line item, including charges the
      // tracker doesn't record (images, tools, storage, fine-tuning).
      console.log("\nBilled line items:");
      for (const item of [...lineItems].sort(
        (a, b) =>
          a.day.localeCompare(b.day) ||
          (a.lineItem ?? "").localeCompare(b.lineItem ?? ""),
      )) {
        console.log(
          `  ${item.day}  ${formatMicros(item.micros).padStart(12)}  ${item.lineItem ?? "(no line item)"}`,
        );
      }
    }
    const { billedMicros, recordedMicros, diffMicros } = report.totals;
    const flagged = report.rows.filter((row) => row.flagged).length;
    const unit = provider === "anthropic" ? "day/model" : "day";
    console.log(
      `\nTotal ${provider === "anthropic" ? "token " : ""}costs: billed ${formatMicros(billedMicros)}, recorded ${formatMicros(recordedMicros)}, diff ${formatMicros(diffMicros)}.` +
        `\n${flagged} of ${report.rows.length} ${unit} row(s) differ by more than ${tolerance}% (and at least $0.01).`,
    );
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
