import assert from "node:assert/strict";
import { Schema } from "effect";
import { test } from "vitest";
import {
  normalizeTansuOrigin,
  SendToTansuRequestSchema,
  SendToTansuResponseSchema,
  TansuImportResultSchema,
  TansuPageOutcomeSchema,
  TansuSettingsSchema,
} from "../src/tansu-schemas.ts";
import { describeTansuResponse } from "../src/tansu-status.ts";

const result = { channel: "tansu", version: 1, type: "import.result", requestId: "r" };

test("normalizes a Tansu URL to its http(s) origin", () => {
  assert.equal(normalizeTansuOrigin(" http://localhost:5173/notes?x=1#y "), "http://localhost:5173");
  assert.equal(normalizeTansuOrigin("https://tansu.example.com/"), "https://tansu.example.com");
  assert.equal(normalizeTansuOrigin("ftp://tansu.example.com"), undefined);
  assert.equal(normalizeTansuOrigin("javascript:alert(1)"), undefined);
  assert.equal(normalizeTansuOrigin("tansu"), undefined);
});

test("settings accept only a bare http(s) origin", () => {
  const decode = Schema.decodeUnknownSync(TansuSettingsSchema);

  assert.deepEqual(decode({}), {});
  assert.deepEqual(decode({ tansuOrigin: "http://localhost:5173" }), {
    tansuOrigin: "http://localhost:5173",
  });
  for (const tansuOrigin of ["https://x.test/path", "ftp://x.test", "x.test", "", 3]) {
    assert.throws(() => decode({ tansuOrigin }));
  }
});

test("decodes success and failure import results and rejects malformed ones", () => {
  const decode = Schema.decodeUnknownSync(TansuImportResultSchema);

  assert.equal(
    decode({ ...result, ok: true, noteId: "n", path: "a.md", imagesLocalized: 2, imagesFailed: 1 }).ok,
    true,
  );
  assert.equal(decode({ ...result, ok: false, error: "nope" }).ok, false);
  assert.throws(() => decode({ ...result, ok: true, noteId: "n" }));
  assert.throws(() => decode({ ...result, version: 2, ok: false, error: "x" }));
  assert.throws(() => decode({ ...result, type: "import.ready", ok: false, error: "x" }));
});

test("decodes page outcomes and service-worker messages", () => {
  assert.deepEqual(
    Schema.decodeUnknownSync(TansuPageOutcomeSchema)({ kind: "timeout", phase: "ready" }),
    { kind: "timeout", phase: "ready" },
  );
  assert.throws(() => Schema.decodeUnknownSync(TansuPageOutcomeSchema)({ kind: "timeout", phase: "x" }));
  assert.throws(() =>
    Schema.decodeUnknownSync(SendToTansuRequestSchema)({ action: "sendToTansu", title: "t" }),
  );
  assert.throws(() =>
    Schema.decodeUnknownSync(SendToTansuResponseSchema)({ ok: false, reason: "other", error: "e" }),
  );
});

test("describes import outcomes for the reader status", () => {
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
  assert.deepEqual(
    describeTansuResponse({ ok: false, reason: "not-configured", error: "Set the URL." }),
    { text: "Set the URL.", action: { kind: "open-options", label: "Open settings" } },
  );
  assert.deepEqual(describeTansuResponse({ ok: false, reason: "failed", error: "boom" }), {
    text: "Could not import to Tansu: boom",
  });
});
