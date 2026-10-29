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
| `npm run db:studio`        | Open Drizzle Studio                                                   |

## Project structure

```
src/
  app/            Next.js App Router pages and layouts
    api/usage/    POST /api/usage route and its request handler
  db/
    schema.ts     Drizzle schema (projects, model_pricing, usage_events)
    index.ts      Server-only database client
    pricing.ts    Look up the price in effect for a model at a time
    usage.ts      Price and store a usage event
    api-keys.ts   Create, authenticate and revoke API keys
    scripts/      `npm run api-key` command
    seed/         Sample project and dated model prices (`npm run db:seed`)
  lib/
    cost.ts       Token cost calculation and USD formatting
    env.ts        Environment variable validation
    pricing.ts    Effective-price selection and numeric parsing
    usage.ts      Usage payload validation
    api-keys.ts   Key generation, hashing and Bearer parsing
drizzle/          Generated SQL migrations
docs/ROADMAP.md   Development roadmap
```

## Data model

- **projects**: a grouping of usage (app, team, or environment) with an optional monthly budget.
- **model_pricing**: USD-per-million-token prices per provider/model, versioned by `effective_from`/`effective_to` so historical costs stay accurate when prices change.
- **usage_events**: individual requests with token counts (including cached input tokens), computed `cost_usd`, and an optional provider `request_id` for de-duplication.

Monetary values use Postgres `numeric` rather than floating-point columns.

### Seed prices

`npm run db:seed` loads prices from [src/db/seed/data.ts](src/db/seed/data.ts). Each entry records its official source URL and the date it was checked. Prices apply from the date they were checked, so earlier usage has no price. Models priced by prompt length, and Anthropic cache-write rates, aren't supported yet (#15). Re-running the seed never overwrites existing rows. To correct a price, add a new row with a later `effectiveFrom`.

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

| Status | `error.code`        | Meaning                                                           |
| ------ | ------------------- | ----------------------------------------------------------------- |
| 201    |                     | Stored; the body is `{ "event": { ..., "costUsd": "0.006000" } }` |
| 400    | `invalid_json`      | Body isn't valid JSON                                             |
| 400    | `invalid_payload`   | Validation failed; see `error.fieldErrors`                        |
| 401    | `unauthorized`      | Missing, malformed, unknown or revoked API key                    |
| 404    | `project_not_found` | The key's project no longer exists                                |
| 409    | `duplicate_request` | An event with this `provider` and `requestId` already exists      |
| 413    | `payload_too_large` | Body is over 64 KB                                                |
| 422    | `no_pricing`        | No price for the model at `occurredAt`                            |

## Testing

- **Unit tests** (`npm test`) need no database.
- **Integration tests** (`npm run test:integration`) run against the database in `DATABASE_URL` and verify the migrated schema and its constraints. Run `npm run db:migrate` first. Tests create rows with unique identifiers and delete them afterwards, but use a development database, never production.

CI runs both. The `database` job starts a Postgres 17 service container with the same credentials as `docker-compose.yml`, fails if `src/db/schema.ts` has changes without a generated migration, applies migrations to an empty database (twice, to confirm re-running is a no-op), seeds it (twice, to confirm the second run inserts nothing), runs the integration tests, and smoke-tests `POST /api/usage` on a dev server against the seeded data, with a real API key (including 401s for missing, unknown and revoked keys).

## Contributing

Work happens through GitHub Issues, feature branches, and Pull Requests against `main`. CI must pass before merging. See [docs/ROADMAP.md](docs/ROADMAP.md) for planned work.
