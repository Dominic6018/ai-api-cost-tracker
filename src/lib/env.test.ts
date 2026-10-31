import { describe, expect, it } from "vitest";
import { parseEnv } from "./env";

describe("parseEnv", () => {
  it("accepts a postgres connection string and defaults NODE_ENV", () => {
    const env = parseEnv({ DATABASE_URL: "postgres://u:p@localhost:5432/db" });
    expect(env.DATABASE_URL).toBe("postgres://u:p@localhost:5432/db");
    expect(env.NODE_ENV).toBe("development");
  });

  it("rejects a missing DATABASE_URL", () => {
    expect(() => parseEnv({})).toThrow(/DATABASE_URL/);
  });

  it("rejects a non-postgres DATABASE_URL", () => {
    expect(() => parseEnv({ DATABASE_URL: "mysql://localhost/db" })).toThrow(
      /postgres/,
    );
  });

  it("doesn't use a pooler by default", () => {
    expect(
      parseEnv({ DATABASE_URL: "postgres://u:p@localhost:5432/db" })
        .DATABASE_POOLED,
    ).toBe(false);
  });

  it.each([
    ["true", true],
    ["false", false],
  ])("reads DATABASE_POOLED=%s", (value, expected) => {
    expect(
      parseEnv({
        DATABASE_URL: "postgres://u:p@localhost:5432/db",
        DATABASE_POOLED: value,
      }).DATABASE_POOLED,
    ).toBe(expected);
  });

  it("rejects an unclear DATABASE_POOLED value", () => {
    expect(() =>
      parseEnv({
        DATABASE_URL: "postgres://u:p@localhost:5432/db",
        DATABASE_POOLED: "yes",
      }),
    ).toThrow(/DATABASE_POOLED/);
  });
});
