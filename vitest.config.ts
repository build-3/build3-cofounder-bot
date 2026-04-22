import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["**/node_modules/**", "tests/_legacy/**"],
    environment: "node",
    reporters: "default",
    passWithNoTests: false,
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/db/migrate.ts", "src/server.ts", "src/ingest/generate_seed.ts"],
    },
    testTimeout: 10_000,
  },
});
