import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // Process entries and their signal/exit handling: covered by spawned boot and CLI tests,
      // which v8 can't see.
      exclude: ["src/index.ts", "src/cli.ts", "src/run.ts"],
      reporter: ["text-summary", "html"],
      thresholds: { lines: 85, branches: 80 },
    },
  },
});
