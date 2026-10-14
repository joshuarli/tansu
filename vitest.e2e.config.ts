import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["web/ts/e2e/*.test.ts"],
    reporters: ["agent"],
    silent: "passed-only",
    sequence: { shuffle: true },
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
