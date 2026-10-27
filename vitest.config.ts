import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Integration tests need a migrated database; run them with `npm run test:integration`.
    exclude: [...configDefaults.exclude, "src/**/*.integration.test.ts"],
  },
});
