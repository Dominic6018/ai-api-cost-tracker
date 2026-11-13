// A support agent that works through four tickets for two customers and
// reports what each step cost, then reads the totals back. Provider calls
// are stand-ins (fake-models.mjs), so it needs no provider keys.
//
// Usage (Node 22.18+, from the repository root):
//   COST_TRACKER_API_KEY=act_...        an ingest key for the project
//   COST_TRACKER_READ_KEY=act_...       optional: a read key, for the totals
//   node examples/support-agent/app.mjs [base URL]

import {
  createCostTracker,
  usageFromResponse,
} from "../../clients/typescript/cost-tracker.ts";
import { classifyTicket, draftReply, summarizeThread } from "./fake-models.mjs";

const baseUrl = process.argv[2] ?? "http://localhost:3000";
const apiKey = process.env.COST_TRACKER_API_KEY;
const readKey = process.env.COST_TRACKER_READ_KEY;
if (!apiKey) {
  console.error(
    "Set COST_TRACKER_API_KEY to a key from `npm run api-key -- create`.",
  );
  process.exit(1);
}

// Request IDs must be unique per project, so each run gets its own.
const sample = `sample-${Date.now()}`;

const tickets = [
  {
    id: "T-101",
    customerId: "cus_acme",
    subject: "Password reset",
    category: "account",
  },
  {
    id: "T-102",
    customerId: "cus_acme",
    subject: "Invoice copy",
    category: "billing",
  },
  {
    id: "T-201",
    customerId: "cus_globex",
    subject: "Long email thread",
    category: "escalation",
    summarize: true,
  },
  {
    id: "T-202",
    customerId: "cus_globex",
    subject: "API errors",
    category: "technical",
    failTriage: true,
  },
];

const errors = [];
const tracker = createCostTracker({
  baseUrl,
  apiKey,
  onError: (error) => errors.push(error),
});

console.log(`Run ${sample}\n`);
let resolved = 0;
for (const ticket of tickets) {
  const runId = `${sample}-${ticket.id}`;
  // Everything this ticket records is attributed to its customer and run.
  const run = tracker.with({
    customerId: ticket.customerId,
    feature: "support-agent",
    runId,
    tags: { sample },
  });

  // Step 1: hold budget for the triage call, then settle it with the usage.
  const reservationId = `${runId}-triage`;
  const hold = await run.reserveBudget({
    reservationId,
    estimatedCostUsd: "0.01",
  });
  if (!hold.allowed) {
    console.log(
      `${ticket.id}  skipped: over budget (${hold.reasons.join(", ")})`,
    );
    continue;
  }
  let triage;
  try {
    const completion = await classifyTicket(ticket, `chatcmpl-${runId}`);
    triage = await run.record({
      ...usageFromResponse(completion),
      reservationId,
    });
  } catch (error) {
    // The step didn't spend, so free its hold for other steps.
    await run.releaseBudget(reservationId);
    console.log(
      `${ticket.id}  triage failed (${error.message}); hold released`,
    );
    continue;
  }
  console.log(
    `${ticket.id}  triage  gpt-4.1                 $${triage.costUsd}`,
  );

  // Step 2: a streamed reply, or a summary for long threads. Both are
  // reported in the background; the app gets the response unchanged.
  if (ticket.summarize) {
    await run.track(summarizeThread(ticket, `gemini-${runId}`));
    console.log(
      `${ticket.id}  summary gemini-3.5-flash-lite   (reported in the background)`,
    );
  } else {
    let reply = "";
    for await (const event of run.trackStream(
      draftReply(ticket, `msg_${runId}`),
    )) {
      if (event.type === "content_block_delta") reply += event.delta.text;
    }
    console.log(
      `${ticket.id}  reply   claude-sonnet-5-5       (streamed: ${reply.length} characters)`,
    );
  }

  await run.recordOutcome({ name: "ticket_resolved", outcomeId: runId });
  resolved += 1;
}

// Wait for the background reports before reading them back or exiting.
await tracker.flush();
const stats = tracker.stats();
console.log(
  `\nBackground reports: ${stats.sent} sent, ${stats.failed} failed, ${stats.dropped} dropped`,
);
if (errors.length > 0 || stats.failed > 0 || stats.dropped > 0) {
  console.error(errors);
  process.exit(1);
}

if (!readKey) {
  console.log("Set COST_TRACKER_READ_KEY to a read key to see the totals.");
  process.exit(0);
}

// The reporting API, with a read key: this run's events, by their tag.
const response = await fetch(
  `${baseUrl}/api/reports/usage?tag=${encodeURIComponent(`sample:${sample}`)}&limit=500`,
  { headers: { authorization: `Bearer ${readKey}` } },
);
if (!response.ok) {
  console.error(
    `GET /api/reports/usage: ${response.status} ${await response.text()}`,
  );
  process.exit(1);
}
const { events } = await response.json();

// Costs are exact decimal strings; add them as integer micro-dollars.
const micros = (usd) => {
  const [whole, fraction = ""] = usd.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
};
const usd = (value) =>
  `$${value / 1_000_000n}.${String(value % 1_000_000n).padStart(6, "0")}`;

const byCustomer = new Map();
for (const event of events) {
  if (event.costUsd === null) {
    console.error(
      `Unpriced: ${event.provider} ${event.model}; run npm run db:seed for the sample prices`,
    );
    process.exit(1);
  }
  byCustomer.set(
    event.customerId,
    (byCustomer.get(event.customerId) ?? 0n) + micros(event.costUsd),
  );
}
console.log(
  `\nStored ${events.length} requests for ${resolved} resolved tickets:`,
);
let total = 0n;
for (const [customerId, cost] of [...byCustomer].sort()) {
  console.log(`  ${customerId.padEnd(12)} ${usd(cost)}`);
  total += cost;
}
console.log(`  ${"Total".padEnd(12)} ${usd(total)}`);
// Rounded down to the micro-dollar.
console.log(`  Per resolved ticket: ${usd(total / BigInt(resolved))}`);
