import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "happy-dom",
    include: ["tests/*.test.ts"],
    reporters: ["agent"],
    silent: "passed-only",
    sequence: { shuffle: true },
  },
});
