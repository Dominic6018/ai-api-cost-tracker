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

# Create the schema
npm run db:migrate

npm run dev
```

Open http://localhost:3000.

## Scripts

| Script                 | Purpose                                      |
| ---------------------- | -------------------------------------------- |
| `npm run dev`          | Start the dev server                         |
| `npm run build`        | Production build                             |
| `npm run lint`         | ESLint                                       |
| `npm run typecheck`    | TypeScript type check                        |
| `npm test`             | Run unit tests once                          |
| `npm run format:check` | Prettier check (`npm run format` to fix)     |
| `npm run db:generate`  | Generate a migration from `src/db/schema.ts` |
| `npm run db:migrate`   | Apply pending migrations                     |
| `npm run db:studio`    | Open Drizzle Studio                          |

## Project structure

```
src/
  app/            Next.js App Router pages and layouts
  db/
    schema.ts     Drizzle schema (projects, model_pricing, usage_events)
    index.ts      Server-only database client
  lib/
    cost.ts       Token cost calculation and USD formatting
    env.ts        Environment variable validation
drizzle/          Generated SQL migrations
docs/ROADMAP.md   Development roadmap
```

## Data model

- **projects**: a grouping of usage (app, team, or environment) with an optional monthly budget.
- **model_pricing**: USD-per-million-token prices per provider/model, versioned by `effective_from`/`effective_to` so historical costs stay accurate when prices change.
- **usage_events**: individual requests with token counts (including cached input tokens), computed `cost_usd`, and an optional provider `request_id` for de-duplication.

Monetary values use Postgres `numeric` rather than floating-point columns.

## Contributing

Work happens through GitHub Issues, feature branches, and Pull Requests against `main`. CI must pass before merging. See [docs/ROADMAP.md](docs/ROADMAP.md) for planned work.
