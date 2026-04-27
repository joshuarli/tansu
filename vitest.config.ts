import { resolve } from "path";

import solid from "vite-plugin-solid";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [solid()],
  resolve: {
    alias: {
      "@joshuarli98/md-wysiwyg": resolve(__dirname, "packages/md-wysiwyg/src/index.ts"),
    },
  },
  test: {
    globals: true,
    environment: "happy-dom",
    include: ["web/ts/*.test.ts", "web/ts/*.test.tsx"],
    reporters: ["agent"],
    silent: "passed-only",
    sequence: { shuffle: true },
    coverage: {
      provider: "v8",
      include: ["web/ts/**/*.ts", "web/ts/**/*.tsx"],
      exclude: [
        "web/ts/webauthn.ts",
        "web/ts/main.tsx",
        "web/ts/legacy-main.ts",
        "web/ts/search-cli.ts",
        "web/ts/e2e/**",
        "web/ts/**/*.test.ts",
      ],
      thresholds: {
        lines: 90,
        functions: 90,
      },
    },
  },
});
