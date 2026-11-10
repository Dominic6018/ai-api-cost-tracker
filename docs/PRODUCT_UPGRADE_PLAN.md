# Product upgrade plan

Phases A to E are Milestones 11 to 15 in the [roadmap](ROADMAP.md). How the product gets from what [the audit](PRODUCT_UPGRADE_AUDIT.md) found to a trustworthy AI cost and profitability platform. Work is ordered so that nothing depends on numbers that can't yet be trusted: the cost ledger and tenant boundaries first, customer billing only after them. Status is tracked in [REQUIREMENTS_TRACEABILITY.md](REQUIREMENTS_TRACEABILITY.md).

Each slice ships as one pull request: schema and migration, logic, API, authorization, UI where it applies, tests, then docs.

## Phase A: financial reliability (in progress)

| Slice | What                                                                                                                                                                                                                                                                            | Depends on | Status      |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ----------- |
| A1    | Exact integer cost arithmetic                                                                                                                                                                                                                                                   | —          | Done (#132) |
| A3a   | Request ids unique per project                                                                                                                                                                                                                                                  | —          | Done (#132) |
| A2    | Keep unpriced usage: nullable cost and a `pricing_status` (`priced`, `unpriced`), shown as a count on the overview and excluded from totals with a visible caveat; an idempotent, audited `npm run reprice` once a price is added; OpenTelemetry spans kept instead of rejected | A1         | Done (#133) |
| A3b   | Ingestion health: counts of accepted, replayed, conflicting, rejected and unpriced events per project and day                                                                                                                                                                   | A2         | Planned     |
| A4    | Budget reservations: `POST /api/budget/reserve` (atomic, row-locked per project), settle on recorded usage by reservation id, expire unsettled ones; the existing check stays advisory and is labelled so in the UI                                                             | A2         | Done (#135) |
| A5    | Per-organization project slugs; organization-scoped audit for command-line changes                                                                                                                                                                                              | —          | Done (#141) |

Gate: Phase A is done when unpriced usage survives and can be priced exactly once, replays never double count, reservations hold under concurrent tests, and every query is organization-scoped (already true).

## Phase B: integration experience

| Slice | What                                                                                                                                                        | Depends on |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| B1    | Client delivery: bounded in-memory queue with backoff and jitter, `flush()` on exit hooks where the runtime allows, counters for dropped usage              | —          |
| B2    | Streaming: wrap OpenAI, Anthropic and Gemini streams to read the final usage without changing what the app receives; mark interrupted streams as incomplete | A2         |
| B3    | Source de-duplication: one request seen by a client and by OpenTelemetry (or LiteLLM) counted once, by a shared source identity and documented precedence   | A3b        |
| B4    | Quickstarts that run end to end, troubleshooting, a deterministic sample app                                                                                | B1, B2     |

## Phase C: billing, credits and profitability

Starts only after Phase A (Gate 1).

| Slice | What                                                                                                                      | Depends on                                      |
| ----- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| C1    | Billing ledger separate from provider cost: customers, plans, allowances, metered usage, adjustments; append-only entries | A2, A4                                          |
| C2    | Credits and entitlements: grant, consume, expire, refund, idempotent                                                      | C1                                              |
| C3    | Optional Stripe (test mode only by default): signed, idempotent webhooks; disabled cleanly when unconfigured              | C1. Needs a Stripe test account from the owner. |
| C4    | Revenue records and a profitability view labelled "revenue minus AI API cost", never "profit"                             | C1                                              |

## Phase D: insights

| Slice | What                                                                                                                                | Depends on |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| D1    | Spend variance: why a period cost more, split into volume, model mix, token mix, cache rate and price changes                       | A2         |
| D2    | Forecasts with method, horizon and a data-sufficiency check; "insufficient data" for sparse history                                 | D1         |
| D3    | Savings scenarios (caching, batching, model choice) from measured workload and prices, labelled as estimates with no quality claims | D1         |

## Phase E: product finish

| Slice | What                                                                                                                                                         | Depends on       |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| E1    | Navigation across Overview, Usage, Prices, Budgets, Customers, Insights, Integrations, Team                                                                  | —                |
| E2    | Onboarding in the UI: create projects and API keys, invite accounts, assign roles; the CLI stays                                                             | A5               |
| E3    | Customer portal: read-only, one customer's usage and billable activity                                                                                       | C1, tenant tests |
| E4    | Three demo scenarios (support SaaS, multi-model agents, usage billing), labelled sample data                                                                 | C2 for the third |
| E5    | Remaining documents: architecture, cost accounting and billing, integrations, demos, competitive matrix, release readiness; screenshots from the running app | each phase       |

## Decisions needed from the owner

- **Stripe test account** (C3), and whether customer billing is in scope at all; the roadmap lists it as optional.
- **An identity provider** for single sign-on.
- **Deployment approval** for any live environment.

## Decisions made here

- **Request ids are scoped to a project**, like `outcomeId`. Two projects can no longer block or detect each other's events. One request reported by two projects is now stored twice, which is a configuration mistake visible in each project's own data.
- **Costs round once, half up, to a micro-dollar per request.** Totals are sums of stored per-request costs, so dashboards, exports and reconciliation agree.
