import { resolve } from "path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@joshuarli98/md-wysiwyg": resolve(__dirname, "packages/md-wysiwyg/src/index.ts"),
    },
  },
  test: {
    globals: true,
    environment: "node",
    include: ["web/ts/e2e/*.test.ts"],
    globalSetup: ["web/ts/e2e/global-setup.ts"],
    reporters: ["agent"],
    silent: "passed-only",
    sequence: { shuffle: true },
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
