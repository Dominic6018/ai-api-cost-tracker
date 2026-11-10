# Product upgrade audit

What the repository actually does, checked against the code on 10 November 2026 (`main` at `c8c13d1`, plus the fixes on branch `feat/product-upgrade-phase-a`). Each claim names the files and the evidence. "Verified" means a test or a command run during this audit confirmed it; "unverified" means it was read in code but not exercised here.

## How the audit was run

| Check                | Command                                                        | Result                                                                                                                |
| -------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Types                | `npm run typecheck`                                            | Pass                                                                                                                  |
| Lint                 | `npm run lint`                                                 | Pass                                                                                                                  |
| Formatting           | `npm run format:check`                                         | Pass                                                                                                                  |
| Unit tests           | `npm test`                                                     | 45 files, 860 tests pass (854 before this audit's fixes)                                                              |
| Python client        | `py -3 -m unittest` in `clients/python`                        | 48 tests pass (last run 8 November)                                                                                   |
| Schema vs migrations | `npx drizzle-kit check`                                        | Pass                                                                                                                  |
| Build                | `npm run build` with a placeholder `DATABASE_URL`              | Pass                                                                                                                  |
| Integration tests    | `npm run test:integration`                                     | **Not run locally**: this machine has no PostgreSQL or Docker. They run in CI (`database` job) on every pull request. |
| Cost precision probe | 200,000 random requests compared with exact integer arithmetic | 420 mismatches before the fix, 0 after (see A1)                                                                       |

## Architecture

```
Provider response ──▶ TS / Python client ──┐
OpenTelemetry span ──▶ POST /api/otel/v1/traces ──┤
Your code ──────────▶ POST /api/usage ────────────┤
                                                  ▼
                 API key (hashed, scoped ingest|read, rate limited)
                                                  ▼
          recordUsage: replay by request id ─▶ price lookup (dated, tiered)
                                                  ▼
                       usage_events (cost_usd numeric(14,6), immutable)
             ┌─────────────────┬──────────────┬───────────────┬──────────────┐
             ▼                 ▼              ▼               ▼              ▼
   Dashboard pages     Budget check API   Notifications   Exports (CSV,   Reconcile vs
   (scoped to the      (advisory, reads   (scheduled,     FOCUS), report  provider bills
   account's org)      recorded spend)    all orgs)       API (per key)   (read only)
```

- **Stack:** Next.js 16 (App Router, server actions), TypeScript, PostgreSQL 17, Drizzle ORM, Zod, Vitest. Clients in `clients/typescript` and `clients/python`.
- **Data model** (`src/db/schema.ts`): `organizations` → `projects` → `usage_events`, `outcomes`, `api_keys`; `users` (role, organization) → `sessions`; `model_pricing` (dated, per tier, with source and check date); `audit_log`; notification ledgers; `rate_limits`.
- **Tenant boundary:** every dashboard query takes a required `OrganizationScope` (`src/db/scope.ts`); API keys are bound to one project. Prices are shared across the install and editable only by admins of the default organization (`src/lib/roles.ts`).

## Findings against the brief's hypotheses

| #   | Hypothesis                                        | Status                             | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --- | ------------------------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | Float arithmetic in cost calculation              | **Confirmed and fixed**            | `calculateCostUsd` summed `tokens × rate` in JavaScript numbers. A probe over 200,000 random requests at seeded rates found 420 (0.21%) stored one micro-dollar low: exact half-micro amounts rounded down because of float noise. In the demo data, 547 of 13,727 events were affected. Now exact integer arithmetic (`calculateCostMicros`, `src/lib/cost.ts`); probe shows 0 mismatches; regression tests in `src/lib/cost.test.ts`. |
| A2  | Unpriced usage is rejected                        | **Confirmed, not yet fixed**       | `recordUsage` returns `no_pricing`, `no_tier_pricing`, `no_batch_pricing`, `no_audio_pricing` or `no_web_search_pricing` and stores nothing (`src/db/usage.ts`). The API answers 422; OpenTelemetry reports the spans as rejected (`src/app/api/otel/v1/traces/handler.ts`). Now stated in the README's limitations. Planned as the next slice.                                                                                         |
| A3  | `(provider, requestId)` unique across all tenants | **Confirmed and fixed**            | The unique index and the replay lookup ignored the project. A second project, even in another organization, sending the same request id got `409 request_id_conflict`: its usage was lost, and the 409 versus 201 told it the id existed elsewhere. Now unique per `(project_id, provider, request_id)` (migration `0028`), with an integration test that both projects record their own event and replay their own.                    |
| A4  | Budget check is not atomic                        | **Confirmed; documented honestly** | `getBudgetCheckInputs` reads recorded spend only and reserves nothing (`src/db/budget-check.ts`). The README says "A check reserves nothing" and that concurrent steps can each be allowed. Reservations and settlement are not built.                                                                                                                                                                                                  |
| B2  | Streaming usage gaps in clients                   | **Confirmed**                      | Neither client wraps streams. `usageFromResponse` returns `null` for a chunk without usage (`clients/typescript/cost-tracker.ts`, `clients/python/cost_tracker.py`).                                                                                                                                                                                                                                                                    |
| B1  | Fire-and-forget telemetry loses data silently     | **Partly**                         | The TypeScript client retries 429/5xx only when a request id makes the retry safe, and reports failures to `onError` (default: console). There's no durable queue, so a process exit before `flush()` loses usage.                                                                                                                                                                                                                      |
| A5  | Cross-tenant query scoping                        | **Verified**                       | Scoped since PR #129; CI tests two organizations query by query and over HTTP.                                                                                                                                                                                                                                                                                                                                                          |
| —   | Slugs unique install-wide                         | **Confirmed**                      | `projects_slug_idx` and `organizations_slug_idx` are global. Documented in the README; not changed.                                                                                                                                                                                                                                                                                                                                     |
| —   | UTC-only reporting days                           | **Confirmed**                      | `src/lib/spend.ts` uses UTC windows; documented. No per-customer time zone.                                                                                                                                                                                                                                                                                                                                                             |
| —   | Manual price maintenance                          | **Confirmed**                      | Prices come from `src/db/seed/data.ts` and `/prices/new`, each with source and check date. No automatic price feed.                                                                                                                                                                                                                                                                                                                     |
| D2  | Simple seven-day forecast                         | **Confirmed**                      | `src/lib/forecast.ts` extrapolates the last 7 full days.                                                                                                                                                                                                                                                                                                                                                                                |
| E3  | CLI-only onboarding                               | **Confirmed**                      | Accounts, organizations and API keys are created with `npm run user`, `org` and `api-key`.                                                                                                                                                                                                                                                                                                                                              |
| —   | README out of date                                | **Confirmed and fixed**            | The status line said Milestone 8 was under way; limitations said per-customer cost was future work. Both rewritten.                                                                                                                                                                                                                                                                                                                     |

## Feature inventory

| Area                                                                                                                                                               | State                                                     | Evidence                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- | ------------------------------------------------------------------------- |
| Dated, tiered pricing (long context, cache durations, batch, flex/fast, audio, image, web search)                                                                  | Verified                                                  | `src/lib/cost.ts`, `src/db/pricing.ts`, unit and integration tests        |
| Idempotent ingestion by request id                                                                                                                                 | Verified (now per project)                                | `src/db/usage.ts`, `src/db/usage.integration.test.ts`                     |
| Clients for OpenAI, Anthropic, Gemini responses                                                                                                                    | Verified for non-streamed responses                       | `clients/*` tests                                                         |
| OpenTelemetry GenAI intake                                                                                                                                         | Verified; drops unpriced spans                            | `src/lib/otlp.ts`, CI smoke test                                          |
| Attribution (customer, user, feature, run, tags), outcomes, cost per outcome                                                                                       | Verified                                                  | `src/db/attribution-spend.ts`, `src/db/outcomes.ts`                       |
| CSV and FOCUS 1.4 exports, reporting API                                                                                                                           | Verified                                                  | `src/db/usage-export.ts`, `src/db/focus-export.ts`, `src/app/api/reports` |
| Budgets, alerts, notifications (webhook, Slack, email)                                                                                                             | Verified                                                  | `src/db/budget-notifications.ts`, CI smoke test                           |
| Budget check                                                                                                                                                       | Verified as advisory                                      | `src/lib/budget-check.ts`                                                 |
| Forecast and spike signals                                                                                                                                         | Verified, simple methods                                  | `src/lib/forecast.ts`, `src/lib/spike.ts`                                 |
| Reconciliation with Anthropic, OpenAI, Google Cloud                                                                                                                | Verified against saved reports; not against live accounts | `src/lib/reconcile.ts`                                                    |
| Roles, audit log, organizations                                                                                                                                    | Verified                                                  | `src/lib/roles.ts`, `src/db/audit.ts`, `src/db/scope.ts`                  |
| Unpriced usage, reservations, customer billing, credits, Stripe, revenue, profitability, customer portal, onboarding UI, team invitations, per-customer time zones | Missing                                                   | —                                                                         |

## Security and privacy posture

- API keys, session tokens and passwords are stored only as hashes (scrypt for passwords). Sign-in and API keys are rate limited.
- No prompts or responses are stored; `metadata` is free-form JSON chosen by the caller.
- Server actions check the session and role themselves (`requirePermission`), not only the page.
- Budget notifications go to one install-wide set of destinations and include project names from every organization.
- Not reviewed in this audit: dependency vulnerabilities beyond `npm audit` (0 production advisories on 8 November), and performance at high volume (no benchmark has been run).

## Operational risks

- Migrations `0025` to `0028` must be applied before deploying this version. `0028` rebuilds a unique index on `usage_events`, which locks writes to that table while it builds; on a large table, run it in a quiet period.
- Scheduled jobs (`budget-alerts`) need an external scheduler; Vercel deployments don't run them.
