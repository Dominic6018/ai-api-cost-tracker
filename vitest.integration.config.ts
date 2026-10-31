import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["src/**/*.integration.test.ts"],
    // Tests share one database, so run files sequentially.
    fileParallelism: false,
    // Some tests load thousands of rows (e.g. demo data).
    testTimeout: 30_000,
  },
});
