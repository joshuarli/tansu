import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "happy-dom",
    pool: "vmThreads",
    include: [
      "web/ts/**/*.test.ts",
      "extension-loupe/test/**/*.test.ts",
      "bench/**/*.test.mjs",
      "scripts/*.test.mjs",
    ],
    exclude: ["web/ts/e2e/**", "extension-loupe/test/**/*.browser.test.ts"],
    reporters: ["agent"],
    silent: "passed-only",
    sequence: { shuffle: true },
  },
});
