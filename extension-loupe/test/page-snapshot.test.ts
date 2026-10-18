import assert from "node:assert/strict";
import { test } from "vitest";
import { assertPageSnapshotWithinLimit, MAX_PAGE_SNAPSHOT_LENGTH } from "../src/page-snapshot.ts";

test("accepts page snapshots at the configured limit", () => {
  assert.doesNotThrow(() => {
    assertPageSnapshotWithinLimit("x".repeat(MAX_PAGE_SNAPSHOT_LENGTH));
  });
});

test("rejects page snapshots above the configured limit", () => {
  assert.throws(
    () => assertPageSnapshotWithinLimit("x".repeat(MAX_PAGE_SNAPSHOT_LENGTH + 1)),
    /page is too large/u,
  );
});
