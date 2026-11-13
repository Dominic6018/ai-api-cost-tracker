// Records one OpenAI response through the TypeScript client and prints its
// stored cost. The response is a fixed one, so no provider key is needed.
//
// Usage (Node 22.18+, from the repository root):
//   COST_TRACKER_API_KEY=act_... node examples/quickstart/quickstart.mjs [base URL]

import {
  createCostTracker,
  usageFromResponse,
} from "../../clients/typescript/cost-tracker.ts";

const baseUrl = process.argv[2] ?? "http://localhost:3000";
const apiKey = process.env.COST_TRACKER_API_KEY;
if (!apiKey) {
  console.error(
    "Set COST_TRACKER_API_KEY to a key from `npm run api-key -- create`.",
  );
  process.exit(1);
}

const tracker = createCostTracker({ baseUrl, apiKey });

// What `openai.chat.completions.create({ model: "gpt-4.1", ... })` returns,
// trimmed to the fields the tracker reads. In your app, wrap the real call
// instead: `await tracker.track(openai.chat.completions.create(...))`.
const completion = {
  id: `chatcmpl-quickstart-${Date.now()}`,
  object: "chat.completion",
  model: "gpt-4.1",
  usage: {
    prompt_tokens: 1200,
    prompt_tokens_details: { cached_tokens: 200 },
    completion_tokens: 80,
  },
};

const usage = usageFromResponse(completion);
const result = await tracker.record({
  ...usage,
  customerId: "cus_quickstart",
  feature: "quickstart",
});

// 1,000 input tokens at $2, 200 cached at $0.50 and 80 output at $8 per million.
console.log(`Stored ${usage.model}: $${result.costUsd}`);
