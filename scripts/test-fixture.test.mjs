import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { assertTestFixtureRoot } from "./test-fixture.mjs";

const REPO_ROOT = resolve(import.meta.dirname, "..");

test("test fixture paths stay under .work or the OS temporary directory", () => {
  assert.doesNotThrow(() => assertTestFixtureRoot(join(REPO_ROOT, ".work", "tmp", "fixture")));
  assert.doesNotThrow(() => assertTestFixtureRoot(join(tmpdir(), "fixture")));
  assert.throws(
    () => assertTestFixtureRoot(join(REPO_ROOT, "tests", "fixtures")),
    /under \.work or the OS temporary directory/,
  );
});
