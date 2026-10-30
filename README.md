# AI API Cost Tracker

Track token usage and spend across AI API providers (OpenAI, Anthropic, Google, Mistral, and others), broken down by project and model.

> **Status:** early development. The project skeleton, database schema, and cost-calculation core are in place; ingestion, dashboards, and budgets are tracked in [docs/ROADMAP.md](docs/ROADMAP.md) and GitHub Issues.

## Tech stack

| Layer      | Choice                                        |
| ---------- | --------------------------------------------- |
| Framework  | Next.js 15 (App Router), React 19             |
| Language   | TypeScript (strict)                           |
| Styling    | Tailwind CSS v4                               |
| Database   | PostgreSQL 17                                 |
| ORM        | Drizzle ORM + drizzle-kit migrations          |
| Validation | Zod                                           |
| Testing    | Vitest                                        |
| CI         | GitHub Actions (lint, typecheck, test, build) |

## Getting started

### Prerequisites

- Node.js 20.9+ (24 recommended)
- PostgreSQL 17, either via Docker (`docker compose`) or a local install

### Setup

```bash
npm install

# Environment: Next.js reads .env.local, drizzle-kit reads .env
cp .env.example .env.local
cp .env.example .env

# Start the development database (or point DATABASE_URL at your own Postgres)
docker compose up -d db

# Create the schema, then add a sample project and model prices
npm run db:migrate
npm run db:seed

npm run dev
```

Open http://localhost:3000.

## Scripts

| Script                     | Purpose                                                               |
| -------------------------- | --------------------------------------------------------------------- |
| `npm run dev`              | Start the dev server                                                  |
| `npm run build`            | Production build                                                      |
| `npm run lint`             | ESLint                                                                |
| `npm run typecheck`        | TypeScript type check                                                 |
| `npm test`                 | Run unit tests once                                                   |
| `npm run test:integration` | Run database integration tests (needs a migrated `DATABASE_URL`)      |
| `npm run format:check`     | Prettier check (`npm run format` to fix)                              |
| `npm run db:generate`      | Generate a migration from `src/db/schema.ts`                          |
| `npm run db:migrate`       | Apply pending migrations                                              |
| `npm run db:seed`          | Add sample data and model prices (safe to re-run; not for production) |
| `npm run api-key`          | Create or revoke ingestion API keys (see Recording usage)             |
| `npm run user`             | Create a dashboard account (see Dashboard)                            |
| `npm run db:studio`        | Open Drizzle Studio                                                   |

## Project structure

```
src/
  app/            Next.js App Router pages and layouts
    api/usage/    POST /api/usage route and its request handler
    login/        Sign-in page and sign-in/sign-out actions
    overview/     Spend totals for today, this month and the last 30 days
    spend/        Daily spend chart and provider/model breakdown
    usage/        Usage events table with filters and pagination
    projects/     Projects list, create and edit pages (server actions)
  db/
    schema.ts     Drizzle schema (projects, model_pricing, usage_events)
    index.ts      Server-only database client
    pricing.ts    Look up the price in effect for a model at a time
    usage.ts      Price and store a usage event
    api-keys.ts   Create, authenticate and revoke API keys
    projects.ts   List, get, create and update projects
    spend.ts      Spend totals per window, per project and overall
    spend-series.ts  Daily spend and provider/model breakdown queries
    usage-events.ts  Keyset-paginated usage event listing
    auth.ts       Users, password checks and sessions
    scripts/      `npm run api-key` and `npm run user` commands
    seed/         Sample project and dated model prices (`npm run db:seed`)
  lib/
    cost.ts       Token cost calculation and USD formatting
    env.ts        Environment variable validation
    pricing.ts    Effective-price selection and numeric parsing
    usage.ts      Usage payload validation
    api-keys.ts   Key generation, hashing and Bearer parsing
    auth.ts       Current user and requireUser() for pages and actions
    login.ts      Sign-in form validation
    passwords.ts  scrypt password hashing
    sessions.ts   Session tokens and safe post-login redirects
    spend.ts      UTC spend window boundaries
    spend-series.ts  Chart ranges, day filling and axis ticks
    budget.ts     Exact budget use, alert thresholds and statuses
    usage-filters.ts Usage filter parsing, date bounds and cursors
    projects.ts   Project form validation
drizzle/          Generated SQL migrations
scripts/          End-to-end smoke tests run in CI
docs/ROADMAP.md   Development roadmap
```

## Data model

- **projects**: a grouping of usage (app, team, or environment) with an optional monthly budget.
- **model_pricing**: USD-per-million-token prices per provider/model, versioned by `effective_from`/`effective_to` so historical costs stay accurate when prices change.
- **usage_events**: individual requests with token counts (including cached input tokens), computed `cost_usd`, and an optional provider `request_id` for de-duplication.

Monetary values use Postgres `numeric` rather than floating-point columns.

### Seed prices

`npm run db:seed` loads prices from [src/db/seed/data.ts](src/db/seed/data.ts). Each entry records its official source URL and the date it was checked. Prices apply from the date they were checked, so earlier usage has no price. Models priced by prompt length, and Anthropic cache-write rates, aren't supported yet (#15). Re-running the seed never overwrites existing rows. To correct a price, add a new row with a later `effectiveFrom`.

## Dashboard

The dashboard requires signing in. Create an account from the command line. The password is read from standard input, so it doesn't end up in your shell history, and it must be at least 12 characters:

```bash
npm run user -- create --email you@example.com < password.txt
```

Then sign in at `/login`. Signed-out visitors to dashboard pages are sent there and returned afterwards.

- **Passwords** are stored as scrypt hashes (N=2^15, r=8, p=3), never in plain text. A wrong password and an unknown email get the same error.
- **Sessions** last 30 days. The `session` cookie is `HttpOnly` and `SameSite=Lax`, and `Secure` in production. It holds a random 256-bit token, and only the token's SHA-256 hash is stored, so signing out revokes the session on the server.
- **Every** dashboard page and server action checks the session itself. All accounts can manage all projects.

- `/overview` is the page you land on after signing in. It shows total spend **today**, **this month** and over the **last 30 days**, overall and per project. Totals are summed in SQL as exact decimals. Today and this month start at midnight **UTC**. The last 30 days is a rolling window of 30 × 24 hours ending now. Usage counts by its `occurredAt`, not when it was received.
  Each project's row also shows **this month's spend against its monthly budget**: the amount, the percentage used (rounded down, so it never shows 100% early), a meter, and how much is left or how far over it is. Projects without a budget show spend only. The budget arithmetic uses whole micro-dollars, so it's exact.
- **Budget alerts.** A project at or above **80%** of its monthly budget shows **Nearing budget**. At or above **100%** it shows **Over budget**, or **Budget used up** when spend equals the budget exactly. A zero budget with any spend is over. Alerts appear as a summary at the top of the overview and the projects list, and next to each project's meter and spend. The thresholds are set once, in `BUDGET_THRESHOLDS` in `src/lib/budget.ts`. Status colors are reserved for alerts, and every alert shows an icon and a label, so it never relies on color alone.
- `/spend` charts daily spend over the last **7, 30 or 90** days (UTC days, ending today) for all projects or one project. Hover or focus a bar to see its value, or open the table view. Below the chart, tables break spend down **by provider** and **by model**, with input, cached input and output tokens and request counts. The range and project filters apply to everything on the page and are kept in the URL (`?range=30&project=<id>`).
- `/usage` lists individual usage events, newest first: time, project, provider, model, token counts, cost and request ID. Filter by project, provider, model and a UTC date range (both ends inclusive). Filters are kept in the URL. Pages hold 50 events. Paging uses `(occurred_at, id)` keysets with microsecond-precise cursors, so events are never skipped or repeated, even when they share a timestamp.
- `/projects` lists projects with their slug and monthly budget.
- `/projects/new` and `/projects/<id>/edit` create and edit projects. Slugs must be unique lowercase words joined by hyphens, and a duplicate slug is shown as an error on the field. The budget accepts an amount with up to two decimal places, or nothing for no budget. Forms also work without JavaScript.

## Recording usage

Each request is authenticated with a per-project API key. The key decides which project the usage belongs to.

### API keys

```bash
# Create a key; it's printed once and can't be shown again
npm run api-key -- create --project sample-app --name my-service

# Revoke a key by its prefix (the first 12 characters, e.g. act_AbCdEfGh)
npm run api-key -- revoke act_AbCdEfGh
```

Keys look like `act_` followed by 43 random characters (32 bytes from a cryptographically secure random source). Only a SHA-256 hash and the 12-character prefix are stored. A presented key is checked against the stored hash in constant time.

### Request

```bash
curl -X POST http://localhost:3000/api/usage   -H "authorization: Bearer $API_KEY"   -H 'content-type: application/json'   -d '{
    "provider": "openai",
    "model": "gpt-4.1",
    "inputTokens": 1000,
    "outputTokens": 500,
    "cachedInputTokens": 0,
    "requestId": "req_abc123",
    "occurredAt": "2026-11-01T12:00:00Z",
    "metadata": { "route": "/chat" }
  }'
```

`cachedInputTokens`, `requestId`, `occurredAt` (ISO 8601 with a time zone; defaults to now, and can't be in the future), and `metadata` (an object of at most 8 KB) are optional. Unknown fields, including `projectId`, are rejected. The cost is computed on the server with the price in effect at `occurredAt`.

**Retries are safe when you send `requestId`** (the provider's request ID, such as OpenAI's `x-request-id`). Repeating a request returns the original event with status 200 instead of storing it twice. The stored cost is kept, even if prices have changed since. The retry must come from the same project and have the same `model` and token counts. `occurredAt` and `metadata` aren't compared. Otherwise it gets a 409. Events without a `requestId` are always stored.

| Status | `error.code`          | Meaning                                                                                      |
| ------ | --------------------- | -------------------------------------------------------------------------------------------- |
| 201    |                       | Stored; the body is `{ "event": { ..., "costUsd": "0.006000" }, "replayed": false }`         |
| 200    |                       | Retry of a stored request; returns the original event with `"replayed": true`                |
| 400    | `invalid_json`        | Body isn't valid JSON                                                                        |
| 400    | `invalid_payload`     | Validation failed; see `error.fieldErrors`                                                   |
| 401    | `unauthorized`        | Missing, malformed, unknown or revoked API key                                               |
| 404    | `project_not_found`   | The key's project no longer exists                                                           |
| 409    | `request_id_conflict` | This `provider` and `requestId` were already used for different usage, or by another project |
| 413    | `payload_too_large`   | Body is over 64 KB                                                                           |
| 422    | `no_pricing`          | No price for the model at `occurredAt`                                                       |

## Testing

- **Unit tests** (`npm test`) need no database.
- **Integration tests** (`npm run test:integration`) run against the database in `DATABASE_URL` and verify the migrated schema and its constraints. Run `npm run db:migrate` first. Tests create rows with unique identifiers and delete them afterwards, but use a development database, never production.

CI runs both. The `database` job starts a Postgres 17 service container with the same credentials as `docker-compose.yml`, fails if `src/db/schema.ts` has changes without a generated migration, applies migrations to an empty database (twice, to confirm re-running is a no-op), seeds it (twice, to confirm the second run inserts nothing), runs the integration tests, and smoke-tests `POST /api/usage` on a dev server against the seeded data, with a real API key (including 401s for missing, unknown and revoked keys), then creates a test account and runs `scripts/smoke-projects.mjs`. That script signs in, creates and edits a project through the real forms, and signs out, confirming a replayed old cookie is rejected. The `check` job also starts the production build and confirms dashboard pages redirect to sign-in while ingestion still requires a key.

## Contributing

Work happens through GitHub Issues, feature branches, and Pull Requests against `main`. CI must pass before merging. See [docs/ROADMAP.md](docs/ROADMAP.md) for planned work.
