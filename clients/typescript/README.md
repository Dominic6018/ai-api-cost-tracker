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

## How usage is read

| API                      | Input tokens                                                                    | Cached / cache writes                                     | Output tokens                                 | `requestId`  |
| ------------------------ | ------------------------------------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------- | ------------ |
| OpenAI Chat Completions  | `prompt_tokens`                                                                 | `prompt_tokens_details.cached_tokens`                     | `completion_tokens` (includes reasoning)      | `id`         |
| OpenAI Responses         | `input_tokens`                                                                  | `input_tokens_details.cached_tokens`                      | `output_tokens` (includes reasoning)          | `id`         |
| Anthropic Messages       | `input_tokens` + cache reads + cache writes (Anthropic reports them separately) | `cache_read_input_tokens` / `cache_creation_input_tokens` | `output_tokens`                               | `id`         |
| Gemini `generateContent` | `promptTokenCount` (includes cached content) + `toolUsePromptTokenCount`        | `cachedContentTokenCount`                                 | `candidatesTokenCount` + `thoughtsTokenCount` | `responseId` |

The provider's response ID becomes `requestId`, so a report that's retried after a network error, 429 or 5xx is stored once. Without a request ID, failed reports aren't retried.

## Things to know

- **Model names must match a price.** OpenAI responses name dated snapshots (`gpt-4.1-2025-04-14`). Pass `{ model: "gpt-4.1" }` to record the alias you requested, or add a price for the snapshot; a snapshot can be priced differently from its alias.
- **OpenAI-compatible APIs**, such as Mistral's, are detected as OpenAI; pass `{ provider: "mistral" }`.
- **Streams aren't read yet.** `track()` needs the final response object; for a stream, report its final usage with `record()`. A response without usage goes to `onError`.
