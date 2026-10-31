# syntax=docker/dockerfile:1

ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-alpine AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci

# Full toolchain for migrations and the `user` / `api-key` commands:
#   docker compose run --rm migrate npm run db:migrate
FROM base AS tools
COPY --from=deps /app/node_modules ./node_modules
COPY . .
USER node
CMD ["npm", "run", "db:migrate"]

FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# public/ may be empty, and Git doesn't keep empty folders.
RUN mkdir -p public
ENV NEXT_OUTPUT=standalone
# A placeholder so environment validation passes during the build. No
# database is contacted and nothing here ends up in the runtime image.
RUN DATABASE_URL=postgres://build:build@localhost:5432/build npm run build

# Minimal runtime: the standalone server only, as the unprivileged `node` user.
FROM base AS runner
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=5 \
  CMD wget -q -O /dev/null http://127.0.0.1:3000/login || exit 1
CMD ["node", "server.js"]
