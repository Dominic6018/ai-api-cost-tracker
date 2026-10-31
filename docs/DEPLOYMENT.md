# Deployment

The app needs two things: a Node.js server and a PostgreSQL 17 database. This guide covers a single server running Docker Compose, and a managed setup on Vercel with hosted Postgres.

## Environment variables

| Variable          | Required | Description                                                                                                                             |
| ----------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`    | Yes      | `postgres://` or `postgresql://` connection string                                                                                      |
| `DATABASE_POOLED` | No       | `true` when `DATABASE_URL` goes through a transaction-mode pooler (PgBouncer, or a hosted provider's pooled endpoint). Default `false`. |
| `NODE_ENV`        | No       | `production` for deployments. The Docker image sets it.                                                                                 |
| `PORT`            | No       | Port the server listens on. Default `3000`.                                                                                             |

With `NODE_ENV=production`, the session cookie is marked `Secure`, so **signing in only works over HTTPS**, or on `http://localhost`.

## Option A: Docker Compose on one server

`docker-compose.yml` runs three services:

- **db**: Postgres 17, with data in the `pgdata` volume. It's published on `127.0.0.1:5432` only.
- **migrate**: applies pending migrations, then exits. The same image runs the `user` and `api-key` commands.
- **app**: the production server on port 3000. It's a Next.js standalone build running as the unprivileged `node` user, and it starts only after migrations succeed.

### 1. Configure

Create a `.env` file next to `docker-compose.yml`. Compose reads it automatically, and it is never copied into the image.

```bash
POSTGRES_PASSWORD=<a long random password>
```

`openssl rand -base64 32` makes a good one. Set it before the first start: Postgres only applies the password when it creates the database.

### 2. Start

```bash
docker compose up -d --build
docker compose ps        # migrate: exited (0), app: healthy
```

### 3. Create the first account and an API key

```bash
# The password is read from standard input (12-256 characters)
docker compose run --rm -T migrate npm run --silent user -- create --email you@example.com < password.txt

# Projects are created on the dashboard; this example uses an existing slug
docker compose run --rm migrate npm run api-key -- create --project my-app --name production
```

The API key is printed once. Store it in your application's secrets.

### 4. Put HTTPS in front

Run a reverse proxy that terminates TLS and forwards to `localhost:3000`. With [Caddy](https://caddyserver.com), the whole configuration is:

```
costs.example.com {
	reverse_proxy localhost:3000
}
```

Don't expose port 3000 directly to the internet.

### Upgrades and backups

```bash
git pull
docker compose up -d --build   # rebuilds, applies new migrations, restarts the app

# Back up the database
docker compose exec -T db pg_dump -U cost_tracker cost_tracker > backup-$(date +%F).sql
```

## Option B: Vercel and hosted Postgres

1. **Create a database** with a hosted Postgres provider such as Neon or Supabase. Note both its **pooled** connection string and its **direct** (unpooled) one.
2. **Apply migrations** from your machine or CI, using the direct connection string:
   ```bash
   DATABASE_URL=<direct connection string> npm run db:migrate
   ```
3. **Deploy the app** to Vercel and set these environment variables:
   - `DATABASE_URL`: the **pooled** connection string. Serverless functions open many short-lived connections, and a pooler keeps them within the database's limits.
   - `DATABASE_POOLED`: `true`. Transaction-mode poolers can't keep prepared statements between transactions, so this turns them off.
4. **Create the first account and API key** from your machine, against the direct connection string:
   ```bash
   DATABASE_URL=<direct connection string> npm run --silent user -- create --email you@example.com < password.txt
   DATABASE_URL=<direct connection string> npm run api-key -- create --project my-app --name production
   ```

Run migrations before deploying a version that needs them, and keep the direct connection string out of the app's environment.

## A public demo

To show the app with realistic data, load the demo set after seeding prices. On a production deployment it needs an explicit flag:

```bash
npm run db:seed
npm run db:demo -- --allow-production          # or: docker compose run --rm migrate npm run db:demo -- --allow-production
```

Re-run it to refresh the data (budgets follow the current month), and remove it with `npm run db:demo -- --remove`. Use a separate database for a public demo, not one holding real usage.

## Production checklist

- [ ] HTTPS in front of the app, so session cookies are sent
- [ ] A strong, unique database password; Postgres not reachable from the internet
- [ ] Migrations applied for the version being deployed
- [ ] Database backups scheduled and a restore tested
- [ ] `npm run db:seed` **not** run against production (it refuses when `NODE_ENV=production`)
- [ ] API keys stored as secrets, and revoked with `npm run api-key -- revoke <prefix>` when no longer needed
- [ ] Until rate limiting lands (#31), limit sign-in and API traffic at your proxy if the app is public
