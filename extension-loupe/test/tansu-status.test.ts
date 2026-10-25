import assert from "node:assert/strict";
import { test } from "vitest";
import { describeTansuResponse } from "../src/tansu-status.ts";

test("describes success import outcomes for the reader status", () => {
  assert.deepEqual(
    describeTansuResponse({ ok: true, noteId: "n", path: "p", imagesLocalized: 3, imagesFailed: 0 }),
    { text: "Imported to Tansu · 3 images", action: { kind: "open-note", label: "Open note" } },
  );
  assert.equal(
    describeTansuResponse({ ok: true, noteId: "n", path: "p", imagesLocalized: 1, imagesFailed: 2 }).text,
    "Imported to Tansu · 1 image · 2 stayed remote",
  );
  assert.equal(
    describeTansuResponse({ ok: true, noteId: "n", path: "p", imagesLocalized: 0, imagesFailed: 0 }).text,
    "Imported to Tansu",
  );
});

test("describes failed import outcomes for the reader status", () => {
  assert.deepEqual(
    describeTansuResponse({ ok: false, reason: "not-configured", error: "Set the URL." }),
    { text: "Set the URL.", action: { kind: "open-options", label: "Open settings" } },
  );
  assert.deepEqual(describeTansuResponse({ ok: false, reason: "failed", error: "boom" }), {
    text: "Could not import to Tansu: boom",
  });
});
