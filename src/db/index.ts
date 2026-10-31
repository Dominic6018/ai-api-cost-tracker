import "server-only";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { parseEnv } from "@/lib/env";
import * as schema from "./schema";

const globalForDb = globalThis as unknown as {
  pgClient?: ReturnType<typeof postgres>;
};

const env = parseEnv();

// Reuse one connection pool across hot reloads in development.
const client =
  globalForDb.pgClient ??
  postgres(env.DATABASE_URL, { max: 10, prepare: !env.DATABASE_POOLED });
if (env.NODE_ENV !== "production") globalForDb.pgClient = client;

export const db = drizzle(client, { schema });
export { schema };
