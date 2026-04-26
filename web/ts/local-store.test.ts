import "fake-indexeddb/auto";
import { openStore, closeStore, kvGet, kvPut, noteGet, notePut, noteDel } from "./local-store.ts";

describe("local-store", () => {
  beforeAll(async () => {
    await openStore();
  });

  afterAll(() => {
    closeStore();
  });

  it("kvGet returns undefined for missing key", async () => {
    await expect(kvGet("nonexistent")).resolves.toBeUndefined();
  });

  it("kvPut + kvGet roundtrip", async () => {
    await kvPut("test-key", { foo: "bar", n: 42 });
    const val = await kvGet<{ foo: string; n: number }>("test-key");
    expect(val).toStrictEqual({ foo: "bar", n: 42 });
  });

  it("kvPut overwrites existing value", async () => {
    await kvPut("overwrite", "first");
    await kvPut("overwrite", "second");
    await expect(kvGet<string>("overwrite")).resolves.toBe("second");
  });

  it("noteGet returns undefined for missing path", async () => {
    await expect(noteGet("no-such-note.md")).resolves.toBeUndefined();
  });

  it("notePut + noteGet roundtrip", async () => {
    await notePut("test.md", "# Hello", 1000, ["alpha"]);
    const note = await noteGet("test.md");
    expect(note).toStrictEqual({ content: "# Hello", mtime: 1000, tags: [] });
  });

  it("noteGet derives tags from frontmatter", async () => {
    await notePut("frontmatter.md", "---\ntags: [alpha, beta]\n---\n\n# Hello", 1000, ["stale"]);
    const note = await noteGet("frontmatter.md");
    expect(note).toStrictEqual({
      content: "---\ntags: [alpha, beta]\n---\n\n# Hello",
      mtime: 1000,
      tags: ["alpha", "beta"],
    });
  });

  it("notePut overwrites existing note", async () => {
    await notePut("overwrite.md", "v1", 1000, []);
    await notePut("overwrite.md", "v2", 2000, ["beta"]);
    await expect(noteGet("overwrite.md")).resolves.toStrictEqual({
      content: "v2",
      mtime: 2000,
      tags: [],
    });
  });

  it("noteDel removes a cached note", async () => {
    await notePut("delete-me.md", "bye", 1000, []);
    await noteDel("delete-me.md");
    await expect(noteGet("delete-me.md")).resolves.toBeUndefined();
  });

  it("noteDel is a no-op for missing path", async () => {
    await noteDel("never-existed.md");
  });
});

describe("local-store graceful degradation (no openStore)", () => {
  // These test the guards that return early when db is null.
  // closeStore was called in the previous describe's afterAll,
  // so db is null here.

  it("kvGet returns undefined", async () => {
    await expect(kvGet("anything")).resolves.toBeUndefined();
  });

  it("kvPut is a silent no-op", async () => {
    await kvPut("key", "val");
    // No throw
  });

  it("noteGet returns undefined", async () => {
    await expect(noteGet("note.md")).resolves.toBeUndefined();
  });

  it("notePut is a silent no-op", async () => {
    await notePut("note.md", "content", 1000, []);
  });

  it("noteDel is a silent no-op", async () => {
    await noteDel("note.md");
  });
});
