// A research agent that splits each task across models: Claude Opus plans,
// gpt-5.4-mini researches each angle, Claude Haiku reviews, and Opus writes
// the answer. Before every step it holds that step's cost against the
// project's run budget; when the budget can't cover the final answer, it
// writes it with the cheaper Haiku instead. Provider calls are stand-ins
// (fake-models.mjs), so it needs no provider keys.
//
// Usage (Node 22.18+, from the repository root):
//   COST_TRACKER_API_KEY=act_...   an ingest key for the project
//   node examples/multi-model-agent/app.mjs [base URL]

import {
  createCostTracker,
  usageFromResponse,
} from "../../clients/typescript/cost-tracker.ts";
import { plan, research, review, write } from "./fake-models.mjs";

const baseUrl = process.argv[2] ?? "http://localhost:3000";
const apiKey = process.env.COST_TRACKER_API_KEY;
if (!apiKey) {
  console.error(
    "Set COST_TRACKER_API_KEY to a key from `npm run api-key -- create`.",
  );
  process.exit(1);
}

// What each step costs at the seed prices, in USD. The agent holds this
// much before the step; recording the step's usage settles the hold.
const STEP_COST = {
  plan: "0.018000", // Opus: 2,000 × $4 + 500 × $20 per million
  research: "0.005850", // gpt-5.4-mini: 3,000 × $0.75 + 800 × $4.50
  review: "0.000550", // Haiku: 4,000 × $0.10 + 300 × $0.50
  write: "0.050000", // Opus: 5,000 × $4 + 1,500 × $20
  "write-lite": "0.001250", // Haiku: 5,000 × $0.10 + 1,500 × $0.50
};

const agents = `agents-${Date.now()}`;
const tasks = [
  { id: "A", customerId: "cus_initech", question: "Pick a CRM", subtasks: 3 },
  {
    id: "B",
    customerId: "cus_umbrella",
    question: "Map the EU AI rules",
    subtasks: 8,
  },
];

const tracker = createCostTracker({ baseUrl, apiKey });

// Costs are exact decimal strings; add them as integer micro-dollars.
const micros = (usd) => {
  const [whole, fraction = ""] = usd.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
};
const usd = (value) =>
  `$${value / 1_000_000n}.${String(value % 1_000_000n).padStart(6, "0")}`;

const byModel = new Map();
let budgetShown = false;

for (const task of tasks) {
  const runId = `${agents}-${task.id}`;
  // Everything this run records is attributed to its customer and run.
  const run = tracker.with({
    customerId: task.customerId,
    feature: "research-agent",
    runId,
    tags: { sample: agents },
  });
  if (!budgetShown) {
    const { run: cap } = await run.checkBudget();
    console.log(
      cap?.capUsd
        ? `Run ${agents}, run budget $${cap.capUsd}\n`
        : `Run ${agents}, no run budget: set one on the project to see the agent stay under it\n`,
    );
    budgetShown = true;
  }
  console.log(`Run ${task.id} for ${task.customerId}: "${task.question}"`);

  let spent = 0n;
  /** Holds a step's cost, runs it, and records its usage to settle the hold. */
  async function step(name, label, call) {
    const reservationId = `${runId}-${label}`;
    const hold = await run.reserveBudget({
      reservationId,
      estimatedCostUsd: STEP_COST[name],
    });
    if (!hold.allowed) return { allowed: false, reasons: hold.reasons };
    const { response, ...rest } = await call(`${reservationId}-req`);
    const usage = usageFromResponse(response);
    const recorded = await run.record({ ...usage, reservationId });
    spent += micros(recorded.costUsd);
    byModel.set(
      usage.model,
      (byModel.get(usage.model) ?? 0n) + micros(recorded.costUsd),
    );
    console.log(
      `  ${label.padEnd(12)} ${usage.model.padEnd(18)} $${recorded.costUsd}`,
    );
    return { allowed: true, ...rest };
  }

  const planned = await step("plan", "plan", async (id) => plan(task, id));
  if (!planned.allowed) {
    console.log(`  stopped before planning (${planned.reasons.join(", ")})`);
    continue;
  }
  for (const [i, subtask] of planned.subtasks.entries()) {
    const done = await step("research", `research-${i + 1}`, async (id) => ({
      response: await research(subtask, id),
    }));
    if (!done.allowed) {
      console.log(`  stopped research (${done.reasons.join(", ")})`);
      break;
    }
  }
  await step("review", "review", async (id) => ({
    response: await review(id),
  }));
  // The answer with Opus if the run budget allows it, else with Haiku.
  const written = await step("write", "write", async (id) => ({
    response: await write("claude-opus-5-5", id),
  }));
  let answered = written.allowed;
  if (!written.allowed) {
    console.log(
      `  write with Opus would pass the run budget (${written.reasons.join(", ")}); using Haiku`,
    );
    const lite = await step("write-lite", "write-lite", async (id) => ({
      response: await write("claude-haiku-5-5", id),
    }));
    answered = lite.allowed;
    if (!lite.allowed) console.log("  stopped: no budget left to write");
  }
  if (answered) {
    await run.recordOutcome({ name: "answer_written", outcomeId: runId });
  }
  console.log(`  run total    ${usd(spent)}\n`);
}

await tracker.flush();

console.log("Cost by model:");
let total = 0n;
for (const [model, cost] of [...byModel].sort()) {
  console.log(`  ${model.padEnd(18)} ${usd(cost)}`);
  total += cost;
}
console.log(`  ${"Total".padEnd(18)} ${usd(total)}`);
