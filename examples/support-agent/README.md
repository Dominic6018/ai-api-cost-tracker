# Sample app: a support agent

A small support agent that shows the tracker in a realistic flow, end to end. It needs a running tracker with the seed prices, and no provider keys: the provider calls in [fake-models.mjs](fake-models.mjs) return fixed responses, shaped like the real SDKs' responses, so every run stores the same costs.

For each of four tickets from two customers, [app.mjs](app.mjs):

1. Reserves $0.01 of budget, triages the ticket with an OpenAI chat completion and records its usage, which settles the hold. Ticket T-202's provider call fails, so its hold is released instead.
2. Drafts a reply with a streamed Anthropic response through `trackStream()`, or summarizes a long thread with Gemini through `track()`. Both report in the background and return the response unchanged.
3. Records a `ticket_resolved` outcome.

Everything a ticket records carries its `customerId`, `feature: "support-agent"`, a `runId` per ticket and a `sample` tag per run. At the end it waits for the background reports, checks none failed, and, given a read key, reads the run's events back from the [reporting API](../../README.md#reporting-api) and totals them per customer.

## Run

Node 22.18+, from the repository root, with the keys from the [quickstart](../../docs/QUICKSTART.md#2-create-api-keys):

```bash
COST_TRACKER_API_KEY=act_... COST_TRACKER_READ_KEY=act_... node examples/support-agent/app.mjs [base URL]
```

```text
Run sample-1794584675584

T-101  triage  gpt-4.1                 $0.002740
T-101  reply   claude-sonnet-5-5       (streamed: 67 characters)
T-102  triage  gpt-4.1                 $0.002740
T-102  reply   claude-sonnet-5-5       (streamed: 65 characters)
T-201  triage  gpt-4.1                 $0.002740
T-201  summary gemini-3.5-flash-lite   (reported in the background)
T-202  triage failed (503 The server is overloaded); hold released

Background reports: 3 sent, 0 failed, 0 dropped

Stored 6 requests for 3 resolved tickets:
  cus_acme     $0.013980
  cus_globex   $0.004340
  Total        $0.018320
  Per resolved ticket: $0.006106
```

The costs, at the seed prices per million tokens:

| Step                           | Tokens                                                      | Cost      |
| ------------------------------ | ----------------------------------------------------------- | --------- |
| Triage, gpt-4.1                | 1,000 input × $2, 200 cached × $0.50, 80 output × $8        | $0.002740 |
| Reply, Claude Sonnet 5.5       | 500 input × $2, 2,500 cache reads × $0.10, 300 output × $10 | $0.004250 |
| Summary, Gemini 3.5 Flash-Lite | 2,000 input × $0.30, 400 output × $2.50                     | $0.001600 |

The cost per resolved ticket is rounded down to the micro-dollar. Each run adds these amounts again under new request IDs. CI runs the app and checks this output, the settled and released holds, and the outcomes.

## Make it real

Replace each stand-in with the real SDK call; the tracking lines stay the same:

```js
const completion = await openai.chat.completions.create({ model: "gpt-4.1", messages });
const stream = anthropic.messages.stream({ model: "claude-sonnet-5-5", max_tokens: 1024, messages });
for await (const event of run.trackStream(stream)) { ... }
await run.track(ai.models.generateContent({ model: "gemini-3.5-flash-lite", contents }));
```
