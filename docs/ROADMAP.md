# Development Roadmap

**Positioning:** a lightweight, self-hosted AI cost ledger. It tells you exactly what each customer, feature and agent run costs, with no prompt data stored. It complements gateways (which route requests and cap spend) and tracing tools (which attach cost to runs) rather than replacing them.

Milestones are delivered in order, and items within a milestone can be worked in parallel. Items link to GitHub Issues; issues for later milestones are opened when the milestone starts. Milestones 5–10 come from a review of the AI cost-tooling market in October 2026, and Milestones 11–15 from the product upgrade audit of November 2026 (see [Why these milestones](#why-these-milestones)).

## Milestone 0: Foundation ✅

- [x] Next.js + TypeScript + Tailwind project skeleton
- [x] PostgreSQL + Drizzle ORM configuration and initial schema
- [x] Environment validation (Zod)
- [x] Cost calculation core with unit tests
- [x] CI: lint, typecheck, format, test, build

## Milestone 1: Data layer ✅

- [x] Verify the initial migration (`drizzle/0000_init.sql`) against a live Postgres, with database integration tests in CI (#1)
- [x] Pricing lookup: resolve the price effective at a given timestamp (#2)
- [x] Seed script for projects and verified model pricing (prices sourced from provider pricing pages, with a source date) (#3)
- [x] Prompt-length pricing tiers and cache-write rates (#15)

## Milestone 2: Ingestion ✅

- [x] `POST /api/usage` endpoint: validate payload, resolve pricing, compute cost, insert event (#4)
- [x] Per-project API keys (hashed at rest) to authenticate ingestion (#5)
- [x] Idempotent ingestion via `(provider, request_id)` (#6)

## Milestone 3: Dashboard ✅

- [x] Projects list and create/edit forms (#7)
- [x] Dashboard authentication: accounts, sign-in and sessions (#20)
- [x] Spend overview: totals for today, this month, and last 30 days (#8)
- [x] Spend over time chart and breakdown by provider/model (#9)
- [x] Usage events table with filtering and pagination (#10)

## Milestone 4: Budgets and alerts ✅

- [x] Budget utilization per project for the current month (#11)
- [x] Threshold alerts (e.g. 80% / 100%) surfaced in the UI (#12)

## Milestone 5: Ship it ✅

Portfolio and production basics: deployable, demonstrable and safe to expose.

- [x] Docker image and deployment guide (#29)
- [x] Demo data generator for a public demo (#30)
- [x] Rate limiting for sign-in and API key authentication (#31)
- [x] Password reset and session revocation from the CLI (#32)
- [x] README showcase: screenshots, positioning and quick start (#33)
- [x] Prepare the repository for public release (#34)

## Milestone 6: Automatic usage capture ✅

Recording usage shouldn't require hand-written API calls.

- [x] TypeScript client that reports usage from OpenAI, Anthropic and Gemini responses, including cached and cache-write tokens (#43)
- [x] Python client with the same usage mappings (#44)
- [x] OpenTelemetry intake that reads the standard GenAI token attributes (`gen_ai.usage.*`) (#45)
- [x] Reconcile recorded costs with Anthropic's cost report (#49)
- [x] The same for OpenAI's costs API, per day (#51)
- [x] Google Cloud billing for Gemini, from a saved BigQuery result, per day (#124)

## Milestone 7: Cost by customer, feature and agent run ✅

- [x] Customer, user, feature and run as indexed, filterable fields (#53)
- [x] Send them from the clients and OpenTelemetry (#54)
- [x] Free-form tags (#77)
- [x] Send tags from the clients and OpenTelemetry (#78)
- [x] Cost per customer, user, feature and run (#57)
- [x] Demo data with customers, users, features and agent runs (#62)
- [x] Unit costs: cost per outcome, such as per resolved ticket (#58)
- [x] Outcomes from the TypeScript and Python clients (#66)
- [x] CSV export of usage events (#71)
- [x] FOCUS 1.4 export, strictly compliant (#73)
- [x] A read-only reporting API, with read-scoped API keys (#75)

## Milestone 8: Guardrails ✅

- Budget notifications at the existing 80% / 100% thresholds:
  - [x] Webhook (signed) and Slack, once per threshold per month (#81)
  - [x] Email (#114)
- [x] A budget check an app calls before spending (allow or deny), with per-run and per-period caps (#83)
- [x] `checkBudget()` in the TypeScript and Python clients (#85)
- [x] Month-end spend forecast on the overview (#87)
- [x] Spending spike detection on the overview (#89)
- [x] Spike and forecast notifications by webhook and Slack (#91)

## Milestone 9: Price management ✅

- [x] A screen for managing prices, requiring a source and check date for every change:
  - [x] Record each price's source and check date, and list prices on `/prices` (#93)
  - [x] Add a price from the screen, requiring both (#95)
  - [x] End a price without a replacement (a retired model) (#97)
- Richer prices:
  - [x] Separate rates per cache duration: Anthropic 1-hour cache writes (#99)
  - [x] Batch API usage at its discounted price (#101)
  - [x] Flex and fast (formerly priority) tiers, at their own prices (#103)
  - [x] Follow announced changes: Gemini 2.5 Pro billed at Gemini 3.8 Flash rates from 2026-12-01 (#107)
  - [x] Non-token charges:
    - [x] Web search, per 1,000 searches (#105)
    - [x] Audio tokens at their own rates (#109)
    - [x] Image tokens at their own rates (#111)
- [x] OpenAI long-context tiers: gpt-5.5, gpt-5.5-pro, gpt-5.4 and gpt-5.4-pro (#116)
- [x] OpenAI's gpt-6 and gpt-5.6 models, with 30-minute and 12-hour cache writes at their own rates (#118)

## Milestone 10: Teams ✅

- [x] Roles on accounts: admin, member and viewer (#120)
- Organizations:
  - [x] Tables, with existing projects and accounts in a default organization (#126)
  - [x] Scope every dashboard page and query to the signed-in account's organization (#128)
  - [x] Create organizations and assign accounts from the command line; only the default organization's admins change the shared prices (#130)
- [x] An audit log of changes (#122)
- [x] Single sign-on with OpenID Connect (#137)

Per-customer billing through Stripe moved to [Milestone 13](#milestone-13-billing-credits-and-profitability): it needs the billing ledger built there first.

## Milestone 11: Financial reliability ✅

Numbers people can trust, before anything is built on them. Details and evidence are in the [upgrade plan](PRODUCT_UPGRADE_PLAN.md) and [audit](PRODUCT_UPGRADE_AUDIT.md).

- [x] Exact integer cost arithmetic (#132)
- [x] Request ids unique per project, so projects can't block or detect each other's events (#132)
- [x] Keep usage that has no price, and price it later with `npm run reprice` (#133)
- [x] Reserve budget atomically before spending (#135)
- [x] Ingestion health: stored, unpriced, replayed, conflicting and invalid counts per project and day (#143)
- [x] Project slugs unique per organization; command-line changes logged in the organization they concern (#141)

## Milestone 12: Integration experience

- [x] Reserve and release budget from the TypeScript and Python clients (#145)
- [x] Reliable client delivery: a bounded queue with backoff, and counts of dropped usage (#147)
- [x] Usage from streamed responses, without changing what the app receives (#149)
- [x] Count a request once when a client and OpenTelemetry (or a gateway) both report it (#151)
- [x] Quickstarts that run end to end, and a sample app (#153)

## Milestone 13: Billing, credits and profitability

Starts only after Milestone 11: customer invoicing must not rest on costs or tenant boundaries that aren't reliable.

- [ ] A billing ledger separate from provider cost: customers, plans, allowances, metered usage, adjustments
- [ ] Credits and entitlements: grant, consume, expire, refund
- [ ] Optional per-customer billing through Stripe, in test mode by default (needs a Stripe test account)
- [ ] Revenue and a "revenue minus AI API cost" view per customer, never labelled profit

## Milestone 14: Insights

- [ ] Why spend changed: volume, model mix, token mix, cache rate and price changes
- [ ] Forecasts that show their method, horizon and whether there's enough data
- [ ] Savings estimates from caching, batching and model choice, labelled as estimates

## Milestone 15: Product finish

- [ ] Navigation across overview, usage, prices, budgets, customers, insights, integrations and team
- [ ] Onboarding in the dashboard: projects, API keys, invitations and roles (the command line stays)
- [ ] A read-only customer portal
- [ ] Three demo scenarios: a support SaaS, multi-model agents, and usage-based billing
- [ ] Architecture, cost accounting, integration and release documents, with screenshots from the running app

## Why these milestones

From the October 2026 market review:

- **Freelance demand:** Upwork's 2026 skills report shows AI integration demand up 178% year over year. Milestone 5 makes this work visible and deployable for clients.
- **Allocation is the top AI FinOps gap:** nearly all FinOps teams now manage AI spend, but provider invoices only split it by key or project. Milestone 7 adds the per-customer, per-feature and per-run views they ask for.
- **Capture friction:** gateway and tracing tools record usage automatically, while this app needs explicit API calls. Milestone 6 closes that gap.
- **From alerts to enforcement:** agent workloads have moved teams to hard per-run caps and pre-spend checks. Milestone 8 builds on the existing thresholds.
- **Prices change often:** a wrong price makes every number wrong. Milestone 9 makes keeping prices correct a routine, audited task.
- **Teams and agencies:** Milestone 10 enables multi-user and client-facing use.

From the November 2026 product upgrade audit, which checked the code against a written brief:

- **Trust first:** the audit confirmed float rounding errors, request ids shared across tenants, unpriced usage being lost and budget checks that couldn't hold under concurrency. Milestone 11 fixes the ledger before anything else uses it.
- **Adoption:** Milestone 12 removes the remaining integration gaps, such as streaming.
- **From cost to margin:** agencies and AI SaaS teams need to bill customers and see AI cost against revenue. Milestone 13 adds that, kept apart from provider cost.
- **Answers, not just totals:** Milestone 14 explains why spend moved, with its assumptions shown.
- **Ready to show:** Milestone 15 makes the product usable without the command line and demonstrable without paid keys.
