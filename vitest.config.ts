import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // index.ts is the process entry (covered by spawned boot tests, which v8 can't see).
      exclude: ["src/index.ts"],
      reporter: ["text-summary", "html"],
      thresholds: { lines: 85, branches: 80 },
    },
  },
});
