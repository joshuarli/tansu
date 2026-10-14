import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "happy-dom",
    include: ["web/ts/**/*.test.ts", "bench/**/*.test.mjs", "scripts/*.test.mjs"],
    exclude: ["web/ts/e2e/**"],
    reporters: ["agent"],
    silent: "passed-only",
    sequence: { shuffle: true },
    coverage: {
      provider: "v8",
      include: ["web/ts/**/*.ts"],
      exclude: [
        "web/ts/e2e/**",
        "web/ts/**/*.test.ts",
        "web/ts/editor/harness/**",
        "web/ts/editor/vendor/atomic/**",
        "web/ts/main.ts",
        "web/ts/types.generated.ts",
      ],
      thresholds: {
        lines: 90,
        functions: 85,
      },
    },
  },
});
