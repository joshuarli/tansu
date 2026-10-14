import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, it } from "vitest";

import { renderCorpusNote, renderStressNote } from "./corpus.mjs";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const SCRATCH_ROOT = join(REPO_ROOT, ".work", "tmp");
const CORPUS_ROOT = join(SCRATCH_ROOT, "o1-corpus");
const SYMLINK_TARGET = join(SCRATCH_ROOT, "o1-corpus-target");
const GENERATOR = resolve(import.meta.dirname, "corpus.mjs");

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
      assert.ok(note.split("\n").every((line) => line.length <= 80));
      assert.ok(note.split("\n\n").length > 2);
    }
  });

  it("replaces an output symlink through the CLI without following it", async () => {
    await rm(CORPUS_ROOT, { recursive: true, force: true });
    await rm(SYMLINK_TARGET, { recursive: true, force: true });
    await mkdir(SYMLINK_TARGET, { recursive: true });
    await writeFile(join(SYMLINK_TARGET, "keep.txt"), "outside the corpus output");
    await symlink(SYMLINK_TARGET, CORPUS_ROOT, "dir");
    try {
      execFileSync(process.execPath, [GENERATOR, "generate", "--seed", "1592594996"], {
        cwd: REPO_ROOT,
        env: { ...process.env, TMPDIR: SCRATCH_ROOT },
        stdio: "ignore",
      });
      assert.equal(await readFile(join(SYMLINK_TARGET, "keep.txt"), "utf8"), "outside the corpus output");
      assert.equal(
        await readFile(join(CORPUS_ROOT, "notes-2500", "note-00001.md"), "utf8"),
        renderCorpusNote(1_592_594_996, 0),
      );
    } finally {
      await rm(CORPUS_ROOT, { recursive: true, force: true });
      await rm(SYMLINK_TARGET, { recursive: true, force: true });
    }
  }, 15_000);
});
