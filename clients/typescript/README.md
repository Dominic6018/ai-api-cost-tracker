# TypeScript client

Reports token usage from OpenAI, Anthropic and Gemini responses to your AI API Cost Tracker, without hand-written API calls. It's a single dependency-free file, [cost-tracker.ts](cost-tracker.ts), that works in Node 18+ and edge runtimes with `fetch`. Only token counts are sent, never prompts or responses. Use it server-side: the API key must stay secret.

## Install

Copy `cost-tracker.ts` into your project. Node 22.18+ can also import it directly, since it runs TypeScript; any bundler or `tsc` handles it as well.

## Use

```ts
import { createCostTracker } from "./cost-tracker";

const tracker = createCostTracker({
  baseUrl: "https://costs.example.com",
  apiKey: process.env.COST_TRACKER_API_KEY!, // a project key from `npm run api-key -- create`
});

// Wrap any call: you get the provider's response back unchanged, and its
// usage is reported in the background.
const reply = await tracker.track(
  anthropic.messages.create({
    model: "claude-sonnet-5-5",
    max_tokens: 1024,
    messages,
  }),
);

const chat = await tracker.track(
  openai.chat.completions.create({ model: "gpt-4.1", messages }),
  { model: "gpt-4.1", metadata: { feature: "support-chat" } },
);

const result = await tracker.track(
  gemini.models.generateContent({ model: "gemini-2.5-pro", contents }),
);

// In serverless functions, wait for reports before returning.
await tracker.flush();
```

`track()` never throws because of reporting. Provider errors reach you as usual, and reporting failures go to `onError`, which logs a warning by default:

```ts
createCostTracker({
  baseUrl,
  apiKey,
  onError: (error, usage) => logger.warn({ error, usage }),
});
```

To send usage yourself, `record()` posts one record and returns the stored cost. It throws a `CostTrackerError` (with `status` and `code`) if the usage isn't stored:

```ts
const { costUsd } = await tracker.record({
  provider: "openai",
  model: "gpt-4.1",
  inputTokens: 1000,
  outputTokens: 500,
  requestId: "chatcmpl-abc123",
});
```

## Attribution

Tag usage with the customer, the end user in your app, the feature and the agent run, so the dashboard can break cost down by them. Each is an ID you choose, up to 200 characters:

```ts
// Per call
await tracker.track(openai.responses.create({ ... }), {
  customerId: "cus_42",
  feature: "support-chat",
  runId: run.id,
});

// Or once per request: a scoped tracker adds it to everything it records
const scoped = tracker.with({ customerId: account.id, userId: user.id });
await scoped.track(anthropic.messages.create({ ... }), { feature: "summaries" });
```

Values passed to `track()` or `record()` win over a scoped tracker's, and scoped trackers can be nested. They share the parent's background reports, so `tracker.flush()` waits for all of them.

## Batch API

Usage from a provider's Batch API is billed at a discount (Anthropic: 50% of every rate). Say so when you report it, and it's priced at the model's batch price:

```ts
for (const result of batchResults) {
  if (result.result.type === "succeeded") {
    await tracker.track(result.result.message, { serviceTier: "batch" });
  }
}
```

`record()` takes `serviceTier: "batch"` on the usage too. Batch usage for a model without a batch price is kept unpriced (`no_batch_pricing`) rather than billed at the full price.

Flex and fast processing (OpenAI's Flex and Fast, formerly Priority; Anthropic's fast mode) work the same way, with `serviceTier: "flex"` or `"fast"`, and are billed at that tier's own price. Usage for a tier without a price is kept unpriced (`no_tier_pricing`).

Anthropic web searches are read from `usage.server_tool_use.web_search_requests` into `webSearchRequests` and charged per 1,000 on top of tokens ($10 for Claude models). Searches for a model without a web search price are kept unpriced (`no_web_search_pricing`).

OpenAI audio tokens are read from Chat Completions (`prompt_tokens_details.audio_tokens`, `completion_tokens_details.audio_tokens`) and from a Realtime API `response.done` event's response (`input_token_details`, cached audio included), and billed at the model's audio rates. A Realtime response names no model, so pass it to `track()` (`{ model: "gpt-realtime-2.1" }`). Audio for a model without audio rates is kept unpriced (`no_audio_pricing`).

OpenAI Images API responses (`images.generate`, `images.edit`) are read too: image input from `input_tokens_details.image_tokens`, and the output as image tokens. They name no model, so pass it to `track()` (`{ model: "gpt-image-2" }`). Image tokens are billed at the model's image rates; on a model without them (a vision model) they're billed as text.

## Tags

Free-form labels for anything attribution doesn't cover: up to 20, keys of 1–64 letters, digits and `_ . / -`, values up to 200 characters. Scoped trackers and calls merge tags key by key, the call's own values winning:

```ts
const prod = tracker.with({ tags: { env: "prod", team: "search" } });
await prod.track(openai.responses.create({ ... }), { tags: { experiment: "b" } });
// Recorded with { env: "prod", team: "search", experiment: "b" }
```

`record()` takes `tags` on the usage. Outcomes have no tags, so `recordOutcome()` leaves a scoped tracker's tags off.

## Outcomes

Record business results, such as a resolved ticket, so the dashboard can show cost per outcome. Attribute them like usage; a scoped tracker adds its attribution:

```ts
const scoped = tracker.with({ customerId: account.id });
await scoped.recordOutcome({ name: "ticket_resolved", outcomeId: ticket.id });
```

`recordOutcome()` returns `{ id, replayed }` and throws a `CostTrackerError` if the outcome isn't stored. With an `outcomeId`, network errors, 429s and 5xx are retried and a repeat isn't counted twice; without one, it isn't retried. `count` (default 1) records a batch.

## Budget check

Ask before an agent step whether the run or the month has room left ([details](../../README.md#budget-check-before-spending)):

```ts
const run = tracker.with({ customerId, runId: agentRun.id });
const check = await run.checkBudget({ estimatedCostUsd: "0.25" });
if (!check.allowed) {
  // check.reasons: ["run_budget"] and/or ["monthly_budget"]
  return stopRun(check.run?.remainingUsd);
}
```

A scoped tracker's `runId` is used unless you pass one. The result has `allowed`, `reasons`, and `month` and `run` blocks with the cap, spent and remaining as exact decimal strings (`run` is `null` without a run ID). A denial isn't an error. Network errors, 429s and 5xx are retried, since a check changes nothing; after that it throws a `CostTrackerError`, so choose whether to fail open or closed:

```ts
const allowed = await run.checkBudget({ estimatedCostUsd: "0.25" }).then(
  (check) => check.allowed,
  () => true,
); // fail open
```

A check doesn't reserve the money: send each step's usage promptly so the next check sees it.

## How usage is read

| API                      | Input tokens                                                                    | Cached / cache writes                                                                                                                          | Output tokens                                 | `requestId`  |
| ------------------------ | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ------------ |
| OpenAI Chat Completions  | `prompt_tokens`                                                                 | `prompt_tokens_details.cached_tokens`                                                                                                          | `completion_tokens` (includes reasoning)      | `id`         |
| OpenAI Responses         | `input_tokens`                                                                  | `input_tokens_details.cached_tokens` / `input_tokens_details.cache_write_tokens` (12-hour writes: `cache_write_tokens_details.ttl_12h_tokens`) | `output_tokens` (includes reasoning)          | `id`         |
| Anthropic Messages       | `input_tokens` + cache reads + cache writes (Anthropic reports them separately) | `cache_read_input_tokens` / `cache_creation_input_tokens` (1-hour writes: `cache_creation.ephemeral_1h_input_tokens`)                          | `output_tokens`                               | `id`         |
| Gemini `generateContent` | `promptTokenCount` (includes cached content) + `toolUsePromptTokenCount`        | `cachedContentTokenCount`                                                                                                                      | `candidatesTokenCount` + `thoughtsTokenCount` | `responseId` |

The provider's response ID becomes `requestId`, so a report that's retried after a network error, 429 or 5xx is stored once. Without a request ID, failed reports aren't retried.

## Things to know

- **Model names must match a price.** OpenAI responses name dated snapshots (`gpt-4.1-2025-04-14`). Pass `{ model: "gpt-4.1" }` to record the alias you requested, or add a price for the snapshot; a snapshot can be priced differently from its alias.
- **OpenAI-compatible APIs**, such as Mistral's, are detected as OpenAI; pass `{ provider: "mistral" }`.
- **Streams aren't read yet.** `track()` needs the final response object; for a stream, report its final usage with `record()`. A response without usage goes to `onError`.
