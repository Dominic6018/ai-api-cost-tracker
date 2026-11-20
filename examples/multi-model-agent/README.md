# Sample app: a multi-model agent under a run budget

A research agent that splits each task across three models and stays under the project's **run budget**, the most any one agent run may spend. It needs a running tracker with the seed prices, and no provider keys: the provider calls in [fake-models.mjs](fake-models.mjs) return fixed responses, shaped like the real SDKs' responses, so every run stores the same costs.

For each of two tasks, from two customers, [app.mjs](app.mjs):

1. Plans the research with **Claude Opus 5.5**.
2. Researches each angle with **gpt-5.4-mini**: three for task A, eight for task B.
3. Reviews the notes with **Claude Haiku 5.5**.
4. Writes the answer with **Opus**, unless the run budget can't cover it. Then it writes it with **Haiku** instead, rather than going over.
5. Records an `answer_written` outcome.

Before every step it calls `reserveBudget()` with that step's cost. That checks the step against the run's spend so far, plus anything already held, and holds the amount. Recording the step's usage with the same `reservationId` settles the hold, so two steps can never both spend the last of a budget. A refused hold stores nothing. Everything a run records carries its `customerId`, `feature: "research-agent"`, a `runId` per task and a `sample` tag per run, so the dashboard's breakdown and spend pages can split it by customer, run and model.

## Run

Set a run budget of $0.10 on the project, under **Projects → Edit → Run budget**. Then, with Node 22.18+, from the repository root, use an ingest key from the [quickstart](../../docs/QUICKSTART.md#2-create-api-keys):

```bash
COST_TRACKER_API_KEY=act_... node examples/multi-model-agent/app.mjs [base URL]
```

```text
Run agents-1795202700644, run budget $0.100000

Run A for cus_initech: "Pick a CRM"
  plan         claude-opus-5-5    $0.018000
  research-1   gpt-5.4-mini       $0.005850
  research-2   gpt-5.4-mini       $0.005850
  research-3   gpt-5.4-mini       $0.005850
  review       claude-haiku-5-5   $0.000550
  write        claude-opus-5-5    $0.050000
  run total    $0.086100

Run B for cus_umbrella: "Map the EU AI rules"
  plan         claude-opus-5-5    $0.018000
  research-1   gpt-5.4-mini       $0.005850
  ...
  research-8   gpt-5.4-mini       $0.005850
  review       claude-haiku-5-5   $0.000550
  write with Opus would pass the run budget (run_budget); using Haiku
  write-lite   claude-haiku-5-5   $0.001250
  run total    $0.066600

Cost by model:
  claude-haiku-5-5   $0.002350
  claude-opus-5-5    $0.086000
  gpt-5.4-mini       $0.064350
  Total              $0.152700
```

Task B has spent $0.065350 by the time it writes. Opus would add $0.050000, which comes to $0.115350, past the $0.10 budget. So the hold is refused and Haiku writes the answer for $0.001250. Without a run budget, the app says so, and task B writes with Opus for a run total of $0.115350.

The costs, at the seed prices per million tokens:

| Step                     | Tokens                             | Cost      |
| ------------------------ | ---------------------------------- | --------- |
| Plan, Claude Opus 5.5    | 2,000 input × $4, 500 × $20        | $0.018000 |
| Research, gpt-5.4-mini   | 3,000 input × $0.75, 800 × $4.50   | $0.005850 |
| Review, Claude Haiku 5.5 | 4,000 input × $0.10, 300 × $0.50   | $0.000550 |
| Write, Claude Opus 5.5   | 5,000 input × $4, 1,500 × $20      | $0.050000 |
| Write, Claude Haiku 5.5  | 5,000 input × $0.10, 1,500 × $0.50 | $0.001250 |

Each run adds these amounts again under new run IDs. CI runs the app with a $0.10 run budget and checks this output, that all 17 holds were settled, and the two outcomes.

## Make it real

Replace each stand-in with the real SDK call. The budget and tracking lines stay the same:

```js
const hold = await run.reserveBudget({
  reservationId,
  estimatedCostUsd: "0.05",
});
if (hold.allowed) {
  const message = await anthropic.messages.create({
    model: "claude-opus-5-5",
    max_tokens: 2048,
    messages,
  });
  await run.record({ ...usageFromResponse(message), reservationId });
}
```

A real step's cost isn't known in advance, so hold an upper bound: its input tokens and `max_tokens` at the model's price. Recording the actual usage settles the hold at what was really spent.
