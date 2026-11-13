# Quickstart

From nothing to a recorded, priced request in about ten minutes, without a provider key or any spend. The scripts and the sample app below run in CI on every change, so their expected output is what you should see.

## 1. Run the tracker

With Docker, from a clone of the repository:

```bash
docker compose up -d --build                     # Postgres, migrations and the app
docker compose run --rm migrate npm run db:seed  # model prices and the sample-app project

# An account for the dashboard; the password is read from standard input (12+ characters)
echo 'choose a long password' | docker compose run --rm -T migrate npm run --silent user -- create --email you@example.com
```

Without Docker, follow [Getting started](../README.md#getting-started) and run the same `npm run` commands directly. The app is at http://localhost:3000.

## 2. Create API keys

```bash
docker compose run --rm migrate npm run --silent api-key -- create --project sample-app --name quickstart
docker compose run --rm migrate npm run --silent api-key -- create --project sample-app --name quickstart-read --scope read
```

Each prints a key starting `act_`, once. The first sends usage; the second, a read key, is only for the sample app's totals in step 4. Keep them out of source control.

```bash
export COST_TRACKER_API_KEY=act_...   # the first key
```

## 3. Record a request

Pick one. Each sends a fixed provider response, so the cost is known in advance.

**curl:**

```bash
curl -s -X POST http://localhost:3000/api/usage \
  -H "authorization: Bearer $COST_TRACKER_API_KEY" -H 'content-type: application/json' \
  -d '{"provider":"openai","model":"gpt-4.1","inputTokens":1200,"cachedInputTokens":200,"outputTokens":80,"feature":"quickstart"}'
```

The response is a 201 with the stored event, including `"costUsd":"0.002740"`.

**TypeScript** (Node 22.18+, which runs the client's TypeScript directly):

```bash
node examples/quickstart/quickstart.mjs
# Stored gpt-4.1: $0.002740
```

**Python** (3.10+, standard library only):

```bash
python3 examples/quickstart/quickstart.py
# Stored claude-sonnet-5-5: $0.004250
```

Pass a different base URL as the first argument if the tracker isn't on `http://localhost:3000`. Then open http://localhost:3000/usage?feature=quickstart to see the request on the dashboard.

[quickstart.mjs](../examples/quickstart/quickstart.mjs) and [quickstart.py](../examples/quickstart/quickstart.py) show where your real provider call goes: wrap it in `tracker.track(...)` instead of building the response by hand.

## 4. Run the sample app

[examples/support-agent](../examples/support-agent/README.md) is a small support agent that works through four tickets for two customers. It reserves budget before each paid step, streams a reply, reports usage in the background, records resolved tickets as outcomes and recovers from a failed provider call. Then it reads the totals back with the read key:

```bash
COST_TRACKER_READ_KEY=act_... node examples/support-agent/app.mjs
```

It ends with:

```text
Stored 6 requests for 3 resolved tickets:
  cus_acme     $0.013980
  cus_globex   $0.004340
  Total        $0.018320
  Per resolved ticket: $0.006106
```

Each run uses new request IDs, so running it again adds the same amounts again. On the dashboard, `/breakdown` shows the cost per customer and per `ticket_resolved` outcome.

## 5. Use it in your app

- **TypeScript or Python:** copy the client file into your project; see the [TypeScript](../clients/typescript/README.md) and [Python](../clients/python/README.md) client guides, including streaming, budgets and outcomes.
- **OpenTelemetry:** point your Collector at the tracker; see [OPENTELEMETRY.md](OPENTELEMETRY.md).
- **Anything else:** call [`POST /api/usage`](../README.md#request).

Keys go in server-side code only. Create one key per service, so you can revoke one without the others.

## Troubleshooting

| What you see                                                     | Why, and what to do                                                                                                                                                                     |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fetch failed`, `ECONNREFUSED` or `Connection refused`           | The app isn't running at that URL. Check `docker compose ps`, and pass the right base URL as the first argument.                                                                        |
| `401 unauthorized`                                               | The key is mistyped, revoked, or from another install. Create a new one; keys can't be shown again.                                                                                     |
| `403 insufficient_scope`                                         | A read key was used to send usage, or an ingest key to read reports. Each key does one or the other.                                                                                    |
| `Stored ...: $null`, or `"pricingStatus":"unpriced"`             | There's no price for that model. Run `npm run db:seed` for the sample prices, or add one at `/prices/new` and run `npm run reprice`. See [Unpriced usage](../README.md#unpriced-usage). |
| `409 request_id_conflict`                                        | That request ID was already stored with different usage. Each provider response has its own ID, so this usually means two different calls were given the same one.                      |
| `ERR_UNKNOWN_FILE_EXTENSION ".ts"` or a syntax error at `import` | Node is older than 22.18 and can't run the TypeScript client. Upgrade Node, or compile `cost-tracker.ts` with your build.                                                               |
| `skipped: over budget` in the sample app                         | The project's monthly or run budget is used up, so the agent stopped before spending. Raise it under `/projects`, or wait for the next month.                                           |
| `429 rate_limited`                                               | Too many requests with invalid keys came from your IP; wait for the `Retry-After` seconds.                                                                                              |
