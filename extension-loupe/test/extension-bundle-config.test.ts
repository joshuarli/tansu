import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "vitest";
import { loupeExtension, outputRootPath } from "../../vite.loupe.config.ts";

test("Loupe builds under the repository-level output root", () => {
  assert.equal(loupeExtension.outputDirectory, resolve(outputRootPath, "extension-loupe"));
});

test("Loupe bundle formats match browser loading contracts", () => {
  assert.deepEqual(
    loupeExtension.bundles.map(({ entryFileName, format }) => ({ entryFileName, format })),
    [
      { entryFileName: "service-worker.js", format: "es" },
      { entryFileName: "content.js", format: "iife" },
      { entryFileName: "tansu-import-page.js", format: "iife" },
      { entryFileName: "[name].js", format: "es" },
    ],
  );
});
