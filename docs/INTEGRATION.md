# Integration guide

How to wire the tracker into a real application, and how to know the wiring is complete. The [quickstart](QUICKSTART.md) gets one request recorded; this guide covers the decisions after that. Each section links to the detailed reference instead of repeating it.

## 1. Choose how to send usage

| Your app                                                  | Use                                                                                          |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| TypeScript or JavaScript, calling provider SDKs directly  | The [TypeScript client](../clients/typescript/README.md): one dependency-free file           |
| Python, calling provider SDKs directly                    | The [Python client](../clients/python/README.md): one file, standard library only            |
| Already instrumented with OpenTelemetry GenAI conventions | The [OpenTelemetry intake](OPENTELEMETRY.md), through your Collector                         |
| Anything else: another language, a gateway, a batch job   | [`POST /api/usage`](../README.md#request) with the token counts from the provider's response |

**Pick one per call.** A call reported by a client and by a span is stored once only when both carry the provider's response ID; see [Reported twice](OPENTELEMETRY.md#reported-twice). Instrumenting each call one way avoids the question.

The tracker only receives token counts. It never calls a provider and never sees prompts or responses.

## 2. Keys

- **One project per product or environment.** A project's key decides where usage lands, and the project's budgets apply to it. Keep production and staging apart.
- **One `ingest` key per service** (`/projects/<id>/keys`, or `npm run api-key -- create`), so one can be revoked without the others. It sends usage, outcomes, traces and budget calls.
- **A `read` key for reporting tools** only. It can't send anything, and an `ingest` key can't read reports.
- **Server-side only.** Keep keys in a secret store or environment variable, such as `COST_TRACKER_API_KEY`, never in a browser or mobile app. A key is shown once; a lost key is replaced, not recovered.

See [API keys](../README.md#api-keys).

## 3. Request IDs and retries

A retried report must not be counted twice, so every usage record should carry the **provider's response ID** as `requestId`. The clients do this for you (`chatcmpl-...`, `msg_...`, Gemini's `responseId`). If you call the API yourself, send it too.

- A repeat with the same ID and the same usage returns the stored event (200, `"replayed": true`). The same ID with different usage is a `409 request_id_conflict`, which usually means two different calls were given one ID.
- **Without a request ID, a report isn't retried** by the clients, since a retry could store it twice.
- **Model names must match a price.** OpenAI responses name dated snapshots (`gpt-4.1-2025-04-14`). Pass the alias you requested (`{ model: "gpt-4.1" }`), or add a price for the snapshot. Otherwise the usage is stored unpriced.
- **Report late usage with its time.** A request is priced as of `occurredAt`, which defaults to when the report arrives. For usage reported long after it happened, such as from a queue or a nightly job, send `occurredAt` with `record()` and `usageFromResponse()` / `usage_from_response()`. `track()` always uses the time of the report.

## 4. Attribution

Attribution is what turns a total into an answer. Choose the IDs before going live, because events aren't re-attributed later.

| Field        | What it should be                                             | Shows up in                                                                                 |
| ------------ | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `customerId` | The paying account, as your billing system knows it           | Cost by customer, plan usage limits, [monthly charges](BILLING.md#monthly-charges), revenue |
| `userId`     | The end user inside that account (not a dashboard account)    | Cost by user, usage filters                                                                 |
| `feature`    | A stable name for the product feature, such as `support-chat` | Cost by feature, cost per outcome                                                           |
| `runId`      | One agent run or workflow, shared by all its calls            | Cost per run, run budgets                                                                   |
| `tags`       | Anything else: `env`, `team`, `experiment`                    | The `tag=key:value` filter on the usage page and reporting API                              |

- **`customerId` is the link to billing.** A [billing customer](BILLING.md) is keyed by the same ID, and a month's usage charge is the cost of every request attributed to that ID in any of the organization's projects. Use one ID per customer everywhere, including outcomes and budget calls.
- **Set it once per request.** A scoped tracker (`tracker.with({...})` in TypeScript, `tracker.with_attribution(...)` in Python) adds attribution to everything recorded through it, so a call can't forget it.
- **Keep values bounded.** Each field is up to 200 characters, and tags up to 20 per event. Use IDs, not free text, and never put personal data in them.

See [Attribution](../clients/typescript/README.md#attribution) and [Tags](../clients/typescript/README.md#tags).

## 5. Streams, batch and tiers

- **Streams:** iterate `tracker.trackStream(stream)` (`track_stream()` in Python) instead of the stream. For OpenAI Chat Completions, set `stream_options: { include_usage: true }`, or there's no usage to read. A stream stopped early reports nothing, rather than a partial count.
- **Batch API results:** report them with `serviceTier: "batch"`, so they're priced at the batch price.
- **Flex and fast tiers:** report them with `serviceTier: "flex"` or `"fast"`; they're priced from the tier's own prices.
- **OpenAI-compatible APIs**, such as Mistral's, are read as OpenAI; pass the real provider.

Usage that a stored price can't cover, such as a tier with no price, is kept as unpriced, never guessed; see [Cost accounting](COST-ACCOUNTING.md#5-unpriced-usage).

## 6. When the tracker is unreachable

Cost tracking should never break your product:

- **`track()` never throws because of reporting.** The provider's response comes back unchanged, and reporting failures go to `onError` / `on_error`. Route that to your logs.
- **Reports are retried** after network errors, 429s and 5xx, when they have a request ID. The TypeScript client also waits at least a 429's `Retry-After`; the Python client doesn't read it.
- **Memory is bounded.** At most 1,000 reports wait at once by default (`maxPending` / `max_pending`); beyond that, new usage is dropped with code `queue_full`.
- **Wait before exiting.** In serverless functions, jobs and scripts, `await tracker.flush()` (`tracker.flush()` in Python) before returning, or pending reports are lost.
- **Watch for loss.** `tracker.stats()` counts `sent`, `failed`, `dropped` and `pending`. Alert on `failed` and `dropped` growing; they're usage that isn't in the tracker.

## 7. Budgets: check or reserve

| You want to                                          | Call                                                                                                                                                                                      |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Know when a budget is crossed                        | Nothing in your app: set the budget on the project, configure a webhook, Slack or email, and schedule `npm run budget-alerts` ([Budget notifications](../README.md#budget-notifications)) |
| Stop a single agent step before it overspends        | `checkBudget()` / `check_budget()` before the step                                                                                                                                        |
| Stop **concurrent** steps from overspending together | `reserveBudget()` before each step, then record its usage with the same `reservationId`, or `releaseBudget()` if it didn't spend                                                          |

- A check reserves nothing, so two steps checked at the same moment can both be allowed. A reservation holds the estimate until the usage settles it, it's released, or it expires (600 seconds by default).
- A denial is an answer, not an error. What to do when the tracker can't be reached, fail open or fail closed, is your decision; the [client guide](../clients/typescript/README.md#budget-check) shows both.
- With a `customerId`, the customer's [plan usage limit](BILLING.md#usage-limits) is checked too.

See [Budget check before spending](../README.md#budget-check-before-spending), and the [multi-model agent](../examples/multi-model-agent/README.md) for reservations in a running agent.

## 8. Outcomes

Record results, such as a resolved ticket, with the same attribution as the usage that produced them, so the dashboard shows cost per outcome. Send an `outcomeId`, your ID for the result, so a retry isn't counted twice. Record outcomes in the same project as their usage. See [Recording outcomes](../README.md#recording-outcomes).

## 9. Check the integration

Before relying on the numbers:

1. **`/ingestion`** shows, per project and day, what was stored, unpriced, replayed, in conflict and invalid. Conflicts and invalid requests are usage that wasn't stored; they should be zero.
2. **Unpriced usage** shows on the overview with its models. Add the missing prices at `/prices/new` and run `npm run reprice`.
3. **The usage page** (`/usage`) filters by customer, user, feature, run and tag. Check that a sample of real calls carries the attribution you expect.
4. **Reconcile with the bill.** After a few days, `npm run reconcile` compares recorded costs with Anthropic's, OpenAI's or Google Cloud's billing, per day. A recorded total well under the bill usually means calls that aren't reported. See [Reconciling with provider bills](../README.md#reconciling-with-provider-bills) and [Cost accounting](COST-ACCOUNTING.md#7-reconciling-with-provider-bills).

## Go-live checklist

- [ ] One project per environment, and one `ingest` key per service, stored as a secret
- [ ] Every provider call goes through `track()`, `trackStream()`, OpenTelemetry or the API, one way per call
- [ ] Every report carries the provider's response ID
- [ ] Model names match stored prices; nothing on the overview is unpriced
- [ ] `customerId` is the same ID your billing uses, set through a scoped tracker
- [ ] `onError` goes to your logs, and `stats()` `failed` and `dropped` are watched
- [ ] Serverless functions and jobs `flush()` before exiting
- [ ] Budgets are set on the project, and `npm run budget-alerts` is scheduled with a destination
- [ ] Agents that run steps in parallel reserve budget rather than only checking it
- [ ] `/ingestion` shows no conflicts or invalid requests, and a reconcile against the provider's bill matches
