import { resolve } from "path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@joshuarli98/md-wysiwyg": resolve(__dirname, "packages/md-wysiwyg/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["web/ts/e2e/*.test.ts"],
    reporters: ["agent"],
    silent: "passed-only",
    sequence: { shuffle: true },
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
