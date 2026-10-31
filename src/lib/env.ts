import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z
    .string()
    .min(1, "DATABASE_URL is required")
    .refine(
      (url) => url.startsWith("postgres://") || url.startsWith("postgresql://"),
      "DATABASE_URL must be a postgres:// or postgresql:// connection string",
    ),
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  // Set to "true" when DATABASE_URL goes through a transaction-mode pooler
  // (PgBouncer, or a hosted provider's pooled endpoint), which can't keep
  // prepared statements between transactions.
  DATABASE_POOLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Parses and validates server environment variables.
 * Throws a readable error listing every invalid variable.
 */
export function parseEnv(
  source: Record<string, string | undefined> = process.env,
): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${details}`);
  }
  return result.data;
}
