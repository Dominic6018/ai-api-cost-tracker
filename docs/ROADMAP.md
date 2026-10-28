# Development Roadmap

Each item below maps to a GitHub Issue. Milestones are delivered in order; items within a milestone can be worked in parallel.

## Milestone 0: Foundation ✅

- [x] Next.js + TypeScript + Tailwind project skeleton
- [x] PostgreSQL + Drizzle ORM configuration and initial schema
- [x] Environment validation (Zod)
- [x] Cost calculation core with unit tests
- [x] CI: lint, typecheck, format, test, build

## Milestone 1: Data layer

- [x] Verify the initial migration (`drizzle/0000_init.sql`) against a live Postgres, with database integration tests in CI (#1)
- [x] Pricing lookup: resolve the price effective at a given timestamp (#2)
- [x] Seed script for projects and verified model pricing (prices sourced from provider pricing pages, with a source date) (#3)
- [ ] Prompt-length pricing tiers and cache-write rates (#15)

## Milestone 2: Ingestion

- [ ] `POST /api/usage` endpoint: validate payload, resolve pricing, compute cost, insert event (#4)
- [ ] Per-project API keys (hashed at rest) to authenticate ingestion (#5)
- [ ] Idempotent ingestion via `(provider, request_id)` (#6)

## Milestone 3: Dashboard

- [ ] Projects list and create/edit forms (#7)
- [ ] Spend overview: totals for today, this month, and last 30 days (#8)
- [ ] Spend over time chart and breakdown by provider/model (#9)
- [ ] Usage events table with filtering and pagination (#10)

## Milestone 4: Budgets and alerts

- [ ] Budget utilization per project for the current month (#11)
- [ ] Threshold alerts (e.g. 80% / 100%) surfaced in the UI (#12)

## Later

- Provider usage-API importers (pull usage instead of push)
- CSV export
- Authentication for the dashboard
