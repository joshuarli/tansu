import assert from "node:assert/strict";
import { test } from "vitest";
import { formatFrontmatterDate, formatPublishedDate } from "../src/published-date.ts";

test("preserves date-only metadata in the display and Markdown calendar date", () => {
  assert.equal(formatPublishedDate("2026-07-12"), "July 12, 2026");
  assert.equal(formatFrontmatterDate("2026-07-12"), "2026-07-12");
});

test("keeps invalid date-only metadata unchanged in Markdown", () => {
  assert.equal(formatFrontmatterDate("2026-19-45"), "2026-19-45");
});
