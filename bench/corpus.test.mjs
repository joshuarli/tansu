import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { renderCorpusNote, renderStressNote } from "./corpus.mjs";

describe("fixed-seed benchmark corpus", () => {
  it("renders identical corpus notes for the same seed and index", () => {
    assert.equal(renderCorpusNote(0x5eed1234, 17), renderCorpusNote(0x5eed1234, 17));
    assert.notEqual(renderCorpusNote(0x5eed1234, 17), renderCorpusNote(0x5eed1235, 17));
  });

  it("renders stress notes with exact UTF-8 byte sizes and representative Markdown", () => {
    for (const sizeBytes of [50, 250, 1_024].map((kilobytes) => kilobytes * 1_024)) {
      const note = renderStressNote(sizeBytes);
      assert.equal(Buffer.byteLength(note, "utf8"), sizeBytes);
      assert.match(note, /\| Column A \| Column B \|/);
      assert.match(note, /!\[Stress image\]/);
      assert.match(note, /café 東京 🧭 Δοκιμή/);
    }
  });
});
