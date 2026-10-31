# Contributing

Thanks for helping. Work happens in small, reviewable steps: an issue, a branch, a pull request, then CI.

## Workflow

1. **Start from an issue.** Open one, or pick one up, describing the problem and how to tell it's done. Planned work is in [docs/ROADMAP.md](docs/ROADMAP.md).
2. **Branch from `main`** with a descriptive name, such as `feat/rate-limiting` or `fix/spend-rounding`.
3. **Commit** with [Conventional Commits](https://www.conventionalcommits.org) messages (`feat:`, `fix:`, `docs:`, `test:`, `chore:`, ...), one meaningful change per commit.
4. **Open a pull request** against `main`. Say what problem it solves, how it's done, how you tested it and any limitations, and link the issue (`Fixes #123`).
5. **CI must pass.** `main` is protected: the `check`, `database` and `docker` jobs have to pass before a pull request can be merged, and nobody pushes to `main` directly.

## Running the checks

Set up the project as described in the [README](README.md#getting-started), then:

```bash
npm run lint
npm run typecheck
npm run format:check   # npm run format fixes it
npm test               # unit tests, no database needed
npm run build
```

### Integration tests

These run against the Postgres in `DATABASE_URL`. Use a development database, never production.

```bash
docker compose up -d db
npm run db:migrate
npm run test:integration
```

Tests create rows with unique identifiers and delete them afterwards.

### Schema changes

Change [src/db/schema.ts](src/db/schema.ts), then run `npm run db:generate` and commit the generated migration in `drizzle/`. CI fails if the schema and migrations disagree.

## What CI runs

| Job        | What it checks                                                                                                  |
| ---------- | --------------------------------------------------------------------------------------------------------------- |
| `check`    | Lint, types, formatting, unit tests, the build, and that the production server requires sign-in and API keys    |
| `database` | Migrations and seed on a fresh Postgres, integration tests, and end-to-end smoke tests of the API and dashboard |
| `docker`   | The Docker image and Compose stack: healthy start, authentication, non-root user, migrations and the CLI        |
| `secrets`  | The full Git history scanned for credentials with [gitleaks](https://github.com/gitleaks/gitleaks)              |

## Guidelines

- Never commit secrets, real API keys or real usage data. `.env` is ignored; copy `.env.example`.
- Keep money exact: costs are decimal strings and `numeric` columns, never floating-point arithmetic.
- Add or update tests with code changes. Pricing changes need their official source and the date it was checked.
- Report security problems privately, as described in [SECURITY.md](SECURITY.md).

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
