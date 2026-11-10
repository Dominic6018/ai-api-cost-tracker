# Python client

Reports token usage from OpenAI, Anthropic and Gemini responses to your AI API Cost Tracker, without hand-written API calls. It's a single file, [cost_tracker.py](cost_tracker.py), using only the standard library (Python 3.10+). Only token counts are sent, never prompts or responses.

## Install

Copy `cost_tracker.py` into your project.

## Use

```python
import os
from cost_tracker import CostTracker

tracker = CostTracker(
    "https://costs.example.com",
    os.environ["COST_TRACKER_API_KEY"],  # a project key from `npm run api-key -- create`
)

# Pass any response: you get it back unchanged, and its usage is reported
# from a background thread.
reply = tracker.track(anthropic.messages.create(model="claude-sonnet-5-5", max_tokens=1024, messages=messages))

chat = tracker.track(
    openai.chat.completions.create(model="gpt-4.1", messages=messages),
    model="gpt-4.1",
    metadata={"feature": "support-chat"},
)

result = tracker.track(gemini.models.generate_content(model="gemini-2.5-pro", contents=contents))

# In scripts, jobs and serverless functions, wait for reports before exiting.
tracker.flush()
```

Responses can be SDK objects (OpenAI, Anthropic, google-genai) or the JSON dicts the REST APIs return. `CostTracker` also works as a context manager, which waits for pending reports on exit.

`track()` never raises because of reporting. Reporting failures go to `on_error`, which logs a warning to the `cost_tracker` logger by default:

```python
CostTracker(base_url, api_key, on_error=lambda error, usage: log.warning("not recorded: %s", error))
```

To send usage yourself, `record()` posts one record and returns the stored cost. It raises `CostTrackerError` (with `status` and `code`) if the usage isn't stored:

```python
from cost_tracker import Usage

result = tracker.record(Usage("openai", "gpt-4.1", input_tokens=1000, output_tokens=500, request_id="chatcmpl-abc123"))
print(result.cost_usd)  # "0.006000"
```

## Attribution

Tag usage with the customer, the end user in your app, the feature and the agent run, so the dashboard can break cost down by them. Each is an ID you choose, up to 200 characters:

```python
# Per call
tracker.track(reply, customer_id="cus_42", feature="support-chat", run_id=run.id)

# Or once per request: a scoped tracker adds it to everything it records
scoped = tracker.with_attribution(customer_id=account.id, user_id=user.id)
scoped.track(reply, feature="summaries")
```

Values passed to `track()` or `record()` win over a scoped tracker's. A scoped tracker shares its parent's background threads, so `flush()` and `close()` on either cover both. `Usage` has `customer_id`, `user_id`, `feature` and `run_id` fields for `record()`.

## Batch API

Usage from a provider's Batch API is billed at a discount (Anthropic: 50% of every rate). Say so when you report it, and it's priced at the model's batch price:

```python
for result in client.messages.batches.results(batch_id):
    if result.result.type == "succeeded":
        tracker.track(result.result.message, service_tier="batch")
```

`Usage` has a `service_tier` field for `record()`. Batch usage for a model without a batch price is kept unpriced (`no_batch_pricing`) rather than billed at the full price.

Flex and fast processing (OpenAI's Flex and Fast, formerly Priority; Anthropic's fast mode) work the same way, with `service_tier="flex"` or `"fast"`, and are billed at that tier's own price. Usage for a tier without a price is kept unpriced (`no_tier_pricing`).

Anthropic web searches are read from `usage.server_tool_use.web_search_requests` into `web_search_requests` and charged per 1,000 on top of tokens ($10 for Claude models). Searches for a model without a web search price are kept unpriced (`no_web_search_pricing`).

OpenAI audio tokens are read from Chat Completions (`prompt_tokens_details.audio_tokens`, `completion_tokens_details.audio_tokens`) and from a Realtime API `response.done` event's response (`input_token_details`, cached audio included), and billed at the model's audio rates. A Realtime response names no model, so pass it to `track()` (`model="gpt-realtime-2.1"`). Audio for a model without audio rates is kept unpriced (`no_audio_pricing`).

OpenAI Images API responses (`images.generate`, `images.edit`) are read too: image input from `input_tokens_details.image_tokens`, and the output as image tokens. They name no model, so pass it to `track()` (`model="gpt-image-2"`). Image tokens are billed at the model's image rates; on a model without them (a vision model) they're billed as text.

## Tags

Free-form labels for anything attribution doesn't cover: up to 20, keys of 1–64 letters, digits and `_ . / -`, values up to 200 characters. Scoped trackers and calls merge tags key by key, the call's own values winning:

```python
prod = tracker.with_attribution(tags={"env": "prod", "team": "search"})
prod.track(reply, tags={"experiment": "b"})
# Recorded with {"env": "prod", "team": "search", "experiment": "b"}
```

`Usage` has a `tags` field for `record()`. Outcomes have no tags, so `record_outcome()` leaves a scoped tracker's tags off.

## Outcomes

Record business results, such as a resolved ticket, so the dashboard can show cost per outcome. Attribute them like usage; a scoped tracker adds its attribution:

```python
scoped = tracker.with_attribution(customer_id=account.id)
scoped.record_outcome("ticket_resolved", outcome_id=ticket.id)
```

`record_outcome()` returns an `OutcomeResult(id, replayed)` and raises `CostTrackerError` if the outcome isn't stored. With an `outcome_id`, network errors, 429s and 5xx are retried and a repeat isn't counted twice; without one, it isn't retried. `count` (default 1) records a batch.

## Budget check

Ask before an agent step whether the run or the month has room left ([details](../../README.md#budget-check-before-spending)):

```python
run = tracker.with_attribution(customer_id=customer_id, run_id=run_id)
check = run.check_budget("0.25")  # a decimal string, int, float or Decimal
if not check.allowed:
    # check.reasons: ("run_budget",) and/or ("monthly_budget",)
    stop_run(check.run.remaining_usd if check.run else None)
```

A scoped tracker's `run_id` is used unless you pass one. The result is a `BudgetCheck` with `allowed`, `reasons`, and `month` and `run` caps (`cap_usd`, `spent_usd`, `remaining_usd` as exact decimal strings; `run` is `None` without a run ID). A denial isn't an error. Network errors, 429s and 5xx are retried, since a check changes nothing; after that it raises `CostTrackerError`, so choose whether to fail open or closed:

```python
try:
    allowed = run.check_budget("0.25").allowed
except CostTrackerError:
    allowed = True  # fail open
```

A check doesn't reserve the money: send each step's usage promptly so the next check sees it. `check_budget()` runs on the calling thread.

## How usage is read

The same mappings as the [TypeScript client](../typescript/README.md#how-usage-is-read):

- **OpenAI Chat Completions and Responses:** cached tokens are part of the input count, and output already includes reasoning tokens. Responses cache writes are read from `input_tokens_details.cache_write_tokens`, and 12-hour writes, billed at a higher rate, from `cache_write_tokens_details.ttl_12h_tokens`.
- **Anthropic Messages:** `input_tokens` excludes cache reads and writes, so they're added back into input. 1-hour cache writes, billed at a higher rate, are read from `cache_creation.ephemeral_1h_input_tokens`.
- **Gemini:** the prompt count already includes cached content; thinking tokens are added to output, and tool-use prompt tokens to input.

The provider's response ID becomes the request ID, so a report retried after a network error, 429 or 5xx is stored once. Without a request ID, failed reports aren't retried.

## Things to know

- **Model names must match a price.** OpenAI responses name dated snapshots (`gpt-4.1-2025-04-14`). Pass `model="gpt-4.1"` to record the alias you requested, or add a price for the snapshot.
- **OpenAI-compatible APIs**, such as Mistral's, are detected as OpenAI; pass `provider="mistral"`.
- **Streams aren't read yet.** Report a stream's final usage with `record()`.
- **`occurred_at` must be timezone-aware** when you set it; it defaults to when the tracker receives the report.

## Tests

```bash
python -m unittest discover -s clients/python -v
```
