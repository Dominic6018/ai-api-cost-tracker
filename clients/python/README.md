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

## How usage is read

The same mappings as the [TypeScript client](../typescript/README.md#how-usage-is-read):

- **OpenAI Chat Completions and Responses:** cached tokens are part of the input count, and output already includes reasoning tokens.
- **Anthropic Messages:** `input_tokens` excludes cache reads and writes, so they're added back into input.
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
