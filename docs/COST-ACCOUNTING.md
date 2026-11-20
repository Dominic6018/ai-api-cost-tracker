# Cost accounting

How the tracker turns a request's token counts into a cost, and how that cost is checked against what the provider billed. It follows one request from the provider's response to the provider's invoice. For the request format see [Recording usage](../README.md#recording-usage), and for what you bill your own customers see [docs/BILLING.md](BILLING.md).

The short version:

1. Your code reports the token counts from the provider's response.
2. The server looks up the price in effect when the request happened.
3. It computes the cost exactly, rounds it once to the micro-dollar, and stores it with the request.
4. If no price applies, the request is stored **unpriced**, never at a guessed price.
5. `npm run reconcile` compares the stored costs with the provider's bill.

## 1. Token counts

The tracker never calls a provider. Your code, or a [client](../clients/typescript/README.md), reports what the provider's response says it used. Providers count differently, so the clients normalize every response to the same fields, in which **`inputTokens` is all input**, cached or not:

| Provider                     | `inputTokens`                                                              | `outputTokens`                                | Cache fields                                                                                                                         |
| ---------------------------- | -------------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| OpenAI (Chat Completions)    | `prompt_tokens`                                                            | `completion_tokens`, which includes reasoning | `prompt_tokens_details.cached_tokens`                                                                                                |
| OpenAI (Responses, Realtime) | `input_tokens`                                                             | `output_tokens`, which includes reasoning     | `input_tokens_details.cached_tokens`                                                                                                 |
| Anthropic                    | `input_tokens` + `cache_read_input_tokens` + `cache_creation_input_tokens` | `output_tokens`                               | reads: `cache_read_input_tokens`; writes: `cache_creation_input_tokens`, of which 1-hour: `cache_creation.ephemeral_1h_input_tokens` |
| Gemini                       | `promptTokenCount` + `toolUsePromptTokenCount`                             | `candidatesTokenCount` + `thoughtsTokenCount` | `cachedContentTokenCount`                                                                                                            |

Anthropic's `input_tokens` leaves out cache reads and writes, so they're added back; the other providers already include them. Audio and image tokens, and Anthropic's web searches (`server_tool_use.web_search_requests`), are read the same way. The fields are each a **part** of a total, never added on top of it: cached input is part of `inputTokens`, audio output is part of `outputTokens`, and so on. The server rejects counts that don't add up, such as more cached tokens than input tokens.

## 2. The price

Prices live in `model_pricing`, one row per provider, model and tier, each with the date it starts (`effective_from`), the date it ends (`effective_to`, if any), the source URL it was read from and the day it was checked. `npm run db:seed` loads the [seed prices](../README.md#seed-prices); admins of the default organization add more at `/prices/new`.

- **Priced as of `occurredAt`.** A request is priced with the row in effect when it **happened**, not when it was reported. Ranges are half-open: a price starting at 2026-12-01T00:00Z applies to a request at exactly that time, and the one it replaces doesn't.
- **One price at a time.** Adding a price ends the earlier one where the new one starts, so a model's history reads as one price after another.
- **Tiers have their own rows.** `standard` and `batch` use the standard row (batch at its multiplier). `flex` and `fast` use their own rows, and are never billed at the standard price.

## 3. The formula

Rates are per million tokens. Each kind of token is billed once, at its own rate:

```text
tokens cost =  uncached text input  × input rate
             + cache reads           × cached-input rate
             + 5-minute cache writes × cache-write rate
             + 1-hour cache writes   × 1-hour cache-write rate
             + text output           × output rate
             + audio input / cached audio input / audio output × the audio rates
             + image input / cached image input / image output × the image rates

cost = tokens cost (× the batch multiplier, for batch)  +  web searches × price per 1,000 ÷ 1,000
```

- **Missing rates fall back.** No cached-input rate means cache reads cost the input rate. No 1-hour rate means 1-hour writes cost the cache-write rate. Image rates fall back to the matching text rates, since vision models bill image input as text.
- **Long prompts.** Some models charge more above a prompt size (Claude Haiku 5.5 above 100,000 tokens, Gemini 2.5 Pro above 200K). A request with **strictly more** input tokens than that threshold, counting cache reads and writes, pays the long rates for **every** token, as the providers bill it.
- **Batch.** Batch requests cost the model's batch multiplier times the whole token cost, long-prompt rates included (Anthropic: 0.5).
- **Web searches** are charged on top of tokens and aren't discounted for batch.

The code is `calculateCostMicros` in [src/lib/cost.ts](../src/lib/cost.ts) and `priceUsage` in [src/db/usage.ts](../src/db/usage.ts).

### A worked example

A Claude Sonnet 5.5 request at the seed prices ($2 input, $0.10 cache reads, $2.50 cache writes, $4 1-hour cache writes, $10 output per million tokens; $10 per 1,000 web searches), reporting 50,000 input tokens, of which 30,000 were cache reads and 10,000 cache writes, 2,000 output tokens and 3 web searches:

| Part           | Tokens                            | Rate          | Cost          |
| -------------- | --------------------------------- | ------------- | ------------- |
| Uncached input | 50,000 − 30,000 − 10,000 = 10,000 | $2            | $0.020000     |
| Cache reads    | 30,000                            | $0.10         | $0.003000     |
| Cache writes   | 10,000                            | $2.50         | $0.025000     |
| Output         | 2,000                             | $10           | $0.020000     |
| **Tokens**     |                                   |               | $0.068000     |
| Web searches   | 3                                 | $10 per 1,000 | $0.030000     |
| **Cost**       |                                   |               | **$0.098000** |

Sent as a batch request, the tokens cost half, $0.034000, and the searches don't, so the cost is $0.064000. Had the writes been 1-hour writes, they'd cost $0.040000 instead of $0.025000, for $0.083000 of tokens. These figures are what `calculateCostMicros` returns for these counts.

## 4. Exact amounts and rounding

- **No floating point.** Rates are stored with six decimals, so each one is a whole number of micro-dollars per million tokens, and token counts are whole numbers. Their product is an exact integer (in millionths of a micro-dollar), computed with `bigint`.
- **Rounded once.** A request's cost is rounded once, half up, to a micro-dollar ($0.000001), after the batch multiplier and before web searches, which are already whole micro-dollars. It's stored as `numeric(14, 6)` in `usage_events.cost_usd`, with the search part in `web_search_cost_usd`.
- **Totals are sums of stored costs.** Every total, chart, budget, report and export adds up the stored per-request costs, exactly. Nothing is recomputed from tokens.
- **Very small requests round per request.** At Claude Haiku 5.5's $0.10 per million input tokens, a 3-token request costs 0.3 micro-dollars and is stored as $0; a 5-token one, 0.5, is stored as $0.000001. Real requests are far larger than a micro-dollar, so this doesn't add up to anything you'd see on a bill.

## 5. Unpriced usage

When no price applies, the request is stored anyway, with no cost, `pricing_status = 'unpriced'` and a reason for what's missing:

| Reason                  | What's missing                                                          |
| ----------------------- | ----------------------------------------------------------------------- |
| `no_pricing`            | Any price for the model at `occurredAt`, such as a new or retired model |
| `no_tier_pricing`       | A `flex` or `fast` price for the model                                  |
| `no_batch_pricing`      | A batch multiplier on the model's price                                 |
| `no_audio_pricing`      | Audio rates, for a request with audio tokens                            |
| `no_web_search_pricing` | A web search price, for a request with searches                         |

Each of these would otherwise mean a wrong cost: batch at the full price, audio as cheaper text, searches as free. Unpriced usage is in no total, budget, notification, reconciliation or FOCUS export; the CSV export marks it in a `pricing_status` column, and the dashboard shows how much there is.

To price it, add the missing price at `/prices/new` with a start **before** the usage, then run `npm run reprice` (`-- --dry-run` to preview). Each request is priced with the rate in effect when it happened, as if the price had been there all along. A request is priced at most once, even by two runs at the same time, and each run is in the audit log. See [Unpriced usage](../README.md#unpriced-usage).

## 6. When prices change

- **Recorded costs never change.** Adding or ending a price doesn't touch usage already priced; the new price applies to requests that happen from its start on. A cost in last month's report stays what it was.
- **Corrections are new prices.** A price entered wrong is corrected by adding a new price with a later start. Usage already priced at the wrong rate keeps that cost: there's no command to re-cost priced usage. Reconciliation (below) is how such a difference shows up.
- **Retired models.** Ending a price without a replacement (`/prices/<id>/end`) makes later requests for the model unpriced (`no_pricing`), rather than priced at a rate that no longer exists.
- **Scheduled changes.** A price can start in the future, as the seed does for Gemini 2.5 Pro's switch to Gemini 3.8 Flash rates on 2026-12-01. Requests on each side of the date get the rate in effect at their own time.

Every price change records its source URL, the day it was checked and who made it, and `/prices` shows each model's history.

## 7. Reconciling with provider bills

Stored costs are computed from reported tokens and stored prices, so they can drift from the bill: a request wasn't reported, a price changed upstream without a new row here, or another app shares the provider account. `npm run reconcile` compares them, per UTC day, and only reads:

| Provider  | Bill read from                                             | Compared                   |
| --------- | ---------------------------------------------------------- | -------------------------- |
| Anthropic | The Admin API cost report (an `sk-ant-admin...` key)       | Per day and model          |
| OpenAI    | The Admin costs API (an `sk-admin-...` key)                | Per day, across all models |
| Google    | A BigQuery billing export, saved as JSON (`--report-file`) | Per day, across all models |

OpenAI's costs and Google's export don't name models in a way the tracker can match, so their days are compared in total, with OpenAI's line items listed under the table.

- **Recorded:** the priced usage for that provider across every project, token cost and web search cost apart. Unpriced usage has no cost to compare, so run `npm run reprice` first.
- **Billed:** token costs line up with recorded costs. Anthropic bills web search per day without a model, so it's compared in total across the range. Billed costs the tracker doesn't record, such as code execution, are listed separately rather than counted as a difference.
- **Flagged:** a row is flagged when recorded and billed differ by more than 2% of the billed amount (`--tolerance`) **and** by at least one cent, since bills are in rounded units. The difference is recorded minus billed, so a negative one means the tracker under-counts.
- Anthropic's cost report is in cents with fractions; it's converted to micro-dollars exactly, rounding half away from zero.

The command and its options are in [Reconciling with provider bills](../README.md#reconciling-with-provider-bills).

## What this doesn't cover

- **Costs beyond tokens and web searches**, such as code execution, file storage, fine-tuning or image generation priced per image, aren't recorded. Reconciliation lists them so they're visible.
- **Negotiated discounts and credits** aren't modelled: costs are at list price. A discount shows up as a difference when reconciling, and Google credits are printed under the table.
- **Currencies other than USD** aren't supported.
