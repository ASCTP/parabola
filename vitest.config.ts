import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/cli-entry.ts", "src/**/index.ts"],
      thresholds: {
        statements: 88,
        branches: 83,
        functions: 93,
        lines: 88,
      },
      reporter: ["text-summary", "text"],
    },
  },
});
