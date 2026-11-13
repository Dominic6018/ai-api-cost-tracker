# OpenTelemetry intake

If your app is already instrumented with OpenTelemetry, the tracker can read token usage straight from your traces. Spans that follow the [GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/) become usage events, priced and de-duplicated like `POST /api/usage`. All other spans are ignored, and no prompt or response content is stored.

## Endpoint

`POST /api/otel/v1/traces` accepts **OTLP/HTTP with JSON encoding**, gzipped or not, authenticated with a project API key (`Authorization: Bearer act_...`). Protobuf isn't supported; it gets a 415 explaining how to switch.

## With the OpenTelemetry Collector (recommended)

Add an `otlphttp` exporter for the tracker to your Collector's traces pipeline:

```yaml
exporters:
  otlphttp/costs:
    endpoint: https://costs.example.com/api/otel # the exporter appends /v1/traces
    encoding: json
    headers:
      authorization: "Bearer ${env:COST_TRACKER_API_KEY}"

processors:
  batch: {}
  # Optional (collector-contrib): forward only spans with GenAI usage.
  filter/genai-usage:
    error_mode: ignore
    traces:
      span:
        - 'attributes["gen_ai.usage.input_tokens"] == nil and attributes["gen_ai.usage.prompt_tokens"] == nil'

service:
  pipelines:
    traces/costs:
      receivers: [otlp]
      processors: [filter/genai-usage, batch]
      exporters: [otlphttp/costs]
```

The Collector works with any SDK, including Python's, whose OTLP exporters send protobuf only.

## Directly from an SDK

SDKs whose OTLP/HTTP exporter sends JSON, such as JavaScript's `@opentelemetry/exporter-trace-otlp-http`, can export straight to the tracker:

```bash
OTEL_EXPORTER_OTLP_TRACES_PROTOCOL=http/json
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://costs.example.com/api/otel/v1/traces
OTEL_EXPORTER_OTLP_TRACES_HEADERS=authorization=Bearer%20act_your_key
```

## How spans are read

| Usage field   | Span attribute                                                                                                                                                                    |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider      | `gen_ai.provider.name`, or the older `gen_ai.system` (`openai`, `azure.ai.openai`, `anthropic`, `gcp.gemini`, `gcp.vertex_ai`, `mistral_ai`, ...; others are recorded as `other`) |
| Model         | `gen_ai.request.model`, else `gen_ai.response.model`                                                                                                                              |
| Input tokens  | `gen_ai.usage.input_tokens`, or the older `gen_ai.usage.prompt_tokens`                                                                                                            |
| Output tokens | `gen_ai.usage.output_tokens`, or the older `gen_ai.usage.completion_tokens`                                                                                                       |
| Cached input  | `gen_ai.usage.cache_read.input_tokens`                                                                                                                                            |
| Cache writes  | `gen_ai.usage.cache_creation.input_tokens`                                                                                                                                        |
| Time          | The span's end time                                                                                                                                                               |
| Request ID    | `gen_ai.response.id` when the span has one, else `otel:<traceId>:<spanId>`; either way a Collector retrying an export doesn't store a span twice                                  |
| Customer      | `cost_tracker.customer_id`                                                                                                                                                        |
| User          | `cost_tracker.user_id`, else the standard `user.id`, else the deprecated `enduser.id`                                                                                             |
| Feature       | `cost_tracker.feature`                                                                                                                                                            |
| Run           | `cost_tracker.run_id`                                                                                                                                                             |
| Tags          | `cost_tracker.tag.<key>`: `cost_tracker.tag.env = "prod"` is the tag `env: prod`                                                                                                  |
| Metadata      | `source: "otel"`, `service.name`, the operation, trace and span IDs                                                                                                               |

- **Attribution** is read from the span's attributes, falling back to the resource's, so a service can set `cost_tracker.feature` once as a resource attribute. Only the user has a standard attribute; the others use these `cost_tracker.*` names. A value the usage API would reject (empty, or over 200 characters) is dropped, and the span's usage is still recorded.
- **Tags** work the same way, key by key: a span's `cost_tracker.tag.env` overrides the resource's, and the resource's other tags still apply. Numbers and booleans become strings. A tag the usage API would reject (a key that isn't 1–64 letters, digits and `_ . / -`, an attribution name such as `customerId`, or an empty or over-200-character value) is dropped, as is any beyond the first 20, span tags first.
- **Only model calls are counted.** Spans whose `gen_ai.operation.name` is `invoke_agent`, `create_agent`, `invoke_workflow`, `execute_tool` or `retrieval` are skipped, because their usage sums up the model calls inside them.
- **Cache traffic is part of input**, as the conventions specify. If an instrumentation reports cache reads and writes outside `input_tokens` (more cache tokens than input), they're added back.
- **The requested model is priced**, because responses often name dated snapshots (`gpt-4.1-2025-04-14`) that have no price of their own.

## Reported twice

If the same call is reported by one of the clients and by an OpenTelemetry span, it's stored once. The clients send the provider's response ID (`chatcmpl-...`, `msg_...`, Gemini's `responseId`) as the request ID, and so does a span with `gen_ai.response.id`, which most GenAI instrumentations set. The second report replays the first. Whichever arrives first is kept: if the second one differs, for example because it names the dated model rather than the alias, it's a `request_id_conflict` and isn't stored, so the cost is never counted twice. Conflicts show on [`/ingestion`](../README.md#ingestion-health). A span without `gen_ai.response.id` can't be matched, so instrument a call one way or the other, not both.

A gateway such as LiteLLM that reports through the API should send the provider's response ID as `requestId` for the same effect.

## Responses

Following OTLP, a successful export returns `200` with `{}`. A span whose model has no price is stored as [unpriced](../README.md#unpriced-usage), not rejected. Spans that couldn't be stored, for example because they have no model or reuse a span ID for different usage, are reported without failing the rest of the export:

```json
{
  "partialSuccess": {
    "rejectedSpans": 2,
    "errorMessage": "2 span(s): invalid model"
  }
}
```

Errors: `401` for a missing or invalid key, `429` with `Retry-After` after repeated invalid keys, `400` for a body that isn't an OTLP JSON export, `413` above 4 MB (after decompression), `415` for protobuf or another encoding.
