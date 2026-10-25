import assert from "node:assert/strict";
import { Schema } from "effect";
import { test } from "vitest";
import {
  LoupeParsedPageSchema,
  normalizeTansuOrigin,
  SendToTansuRequestSchema,
  SendToTansuResponseSchema,
  TansuImportResultSchema,
  TansuPageOutcomeSchema,
  TansuSettingsSchema,
} from "../src/tansu-schemas.ts";

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

test("decodes the narrow defuddle-wasm page JSON and rejects malformed payloads", () => {
  const decode = Schema.decodeUnknownSync(LoupeParsedPageSchema),
    page = {
      content: "<p>Body.</p>",
      content_markdown: "Body.",
      title: "Title",
      author: "Author",
      description: "Description",
      published: "2026-07-12",
      site: "Site",
      domain: "example.com",
      extractor_type: null,
    };

  assert.deepEqual(decode(page), page);
  assert.equal(decode({ ...page, content_markdown: null, extractor_type: "default" }).extractor_type, "default");
});

test.each([
  ["null content", { content: null }],
  ["missing content_markdown", { content_markdown: undefined }],
  ["numeric extractor_type", { extractor_type: 3 }],
  ["missing domain", { domain: undefined }],
])("rejects a parsed page with %s", (_label, override) => {
  const page = {
    content: "<p>Body.</p>",
    content_markdown: "Body.",
    title: "Title",
    author: "Author",
    description: "Description",
    published: "2026-07-12",
    site: "Site",
    domain: "example.com",
    extractor_type: null,
  };
  assert.throws(() => Schema.decodeUnknownSync(LoupeParsedPageSchema)({ ...page, ...override }));
});

test.each([["a string"], [null], [[]]])("rejects a non-object parsed page %p", (malformed) => {
  assert.throws(() => Schema.decodeUnknownSync(LoupeParsedPageSchema)(malformed));
});
