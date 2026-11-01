// Records usage through the TypeScript client (clients/typescript) against
// a running app with seed prices, and checks the stored cost.
//
// Usage: COST_TRACKER_API_KEY=... node scripts/smoke-client.mjs [base URL]

import assert from "node:assert/strict";
import {
  CostTrackerError,
  createCostTracker,
  usageFromResponse,
} from "../clients/typescript/cost-tracker.ts";

const baseUrl = process.argv[2] ?? "http://localhost:3000";
const apiKey = process.env.COST_TRACKER_API_KEY;
assert.ok(apiKey, "set COST_TRACKER_API_KEY");

// An Anthropic Messages response as the SDK returns it, trimmed.
const message = {
  id: `msg_smoke_${Date.now()}`,
  type: "message",
  model: "claude-sonnet-5-5",
  content: [],
  usage: {
    input_tokens: 50,
    cache_creation_input_tokens: 2000,
    cache_read_input_tokens: 8000,
    output_tokens: 400,
  },
};

console.log("- track() returns the response and reports it in the background");
const errors = [];
const tracker = createCostTracker({
  baseUrl,
  apiKey,
  onError: (error) => errors.push(error),
});
assert.equal(await tracker.track(Promise.resolve(message)), message);
await tracker.flush();
assert.deepEqual(errors, []);

console.log("- the stored cost uses cache read and write rates");
// Claude Sonnet 5.5 seed prices per 1M tokens: $2 input, $0.10 cache
// reads, $2.50 cache writes, $10 output.
// 50 * 2 + 8,000 * 0.10 + 2,000 * 2.50 + 400 * 10 = 9,900 -> $0.009900
const replay = await tracker.record(usageFromResponse(message));
assert.deepEqual(replay, { costUsd: "0.009900", replayed: true });

console.log("- a rejected key never reaches the caller of track()");
const rejected = [];
const badTracker = createCostTracker({
  baseUrl,
  apiKey: "act_" + "x".repeat(43),
  retries: 0,
  onError: (error) => rejected.push(error),
});
assert.equal(await badTracker.track(message), message);
await badTracker.flush();
assert.equal(rejected.length, 1);
assert.ok(rejected[0] instanceof CostTrackerError);
// 401, or 429 if earlier CI steps already used up this address's limit.
assert.ok([401, 429].includes(rejected[0].status), `got ${rejected[0].status}`);

console.log("TypeScript client smoke test passed.");
