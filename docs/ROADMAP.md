# Development Roadmap

**Positioning:** a lightweight, self-hosted AI cost ledger. It tells you exactly what each customer, feature and agent run costs, with no prompt data stored. It complements gateways (which route requests and cap spend) and tracing tools (which attach cost to runs) rather than replacing them.

Milestones are delivered in order, and items within a milestone can be worked in parallel. Items link to GitHub Issues; issues for later milestones are opened when the milestone starts. Milestones 5–10 come from a review of the AI cost-tooling market in October 2026 (see [Why these milestones](#why-these-milestones)).

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

## Milestone 6: Automatic usage capture

Recording usage shouldn't require hand-written API calls.

- [x] TypeScript client that reports usage from OpenAI, Anthropic and Gemini responses, including cached and cache-write tokens (#43)
- [ ] Python client with the same usage mappings (#44)
- [ ] OpenTelemetry intake that reads the standard GenAI token attributes (`gen_ai.usage.*`) (#45)
- [ ] Import from provider usage and cost APIs, to reconcile recorded costs with provider invoices

## Milestone 7: Cost by customer, feature and agent run

- [ ] Customer, user, feature and run as indexed, filterable fields, plus free-form tags
- [ ] Cost per customer and per feature, and unit costs (e.g. cost per resolved ticket)
- [ ] CSV and FOCUS exports, and a read-only reporting API

## Milestone 8: Guardrails

- [ ] Budget notifications by email, Slack and webhook at the existing 80% / 100% thresholds
- [ ] A budget check an app calls before spending (allow or deny), with per-run and per-period caps
- [ ] Month-end spend forecast and spike detection

## Milestone 9: Price management

- [ ] A screen for managing prices, requiring a source and check date for every change
- [ ] Separate rates per cache duration; batch, flex and priority tiers; non-token charges (search, images, audio)
- [ ] OpenAI long-context tiers, once their rates can be verified from the pricing page

## Milestone 10: Teams

- [ ] Organizations, roles (admin, member, viewer) and an audit log; single sign-on later
- [ ] Optional per-customer billing through Stripe

## Why these milestones

From the October 2026 market review:

- **Freelance demand:** Upwork's 2026 skills report shows AI integration demand up 178% year over year. Milestone 5 makes this work visible and deployable for clients.
- **Allocation is the top AI FinOps gap:** nearly all FinOps teams now manage AI spend, but provider invoices only split it by key or project. Milestone 7 adds the per-customer, per-feature and per-run views they ask for.
- **Capture friction:** gateway and tracing tools record usage automatically, while this app needs explicit API calls. Milestone 6 closes that gap.
- **From alerts to enforcement:** agent workloads have moved teams to hard per-run caps and pre-spend checks. Milestone 8 builds on the existing thresholds.
- **Prices change often:** a wrong price makes every number wrong. Milestone 9 makes keeping prices correct a routine, audited task.
- **Teams and agencies:** Milestone 10 enables multi-user and client-facing use.
