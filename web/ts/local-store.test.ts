import "fake-indexeddb/auto";
import { openStore, closeStore, kvGet, kvPut, noteGet, notePut, noteDel } from "./local-store.ts";
import { setupDOM } from "./test-helper.ts";

const DEFAULT_VAULT = 0;

describe("local-store", () => {
  let cleanup: (() => void) | null = null;

  beforeAll(async () => {
    cleanup = setupDOM();
    await openStore();
  });

  afterAll(() => {
    closeStore();
    cleanup?.();
  });

  it("kvGet returns undefined for missing key", async () => {
    await expect(kvGet(DEFAULT_VAULT, "nonexistent")).resolves.toBeUndefined();
  });

  it("kvPut + kvGet roundtrip", async () => {
    await kvPut(DEFAULT_VAULT, "test-key", { foo: "bar", n: 42 });
    const val = await kvGet<{ foo: string; n: number }>(DEFAULT_VAULT, "test-key");
    expect(val).toStrictEqual({ foo: "bar", n: 42 });
  });

  it("kvPut overwrites existing value", async () => {
    await kvPut(DEFAULT_VAULT, "overwrite", "first");
    await kvPut(DEFAULT_VAULT, "overwrite", "second");
    await expect(kvGet<string>(DEFAULT_VAULT, "overwrite")).resolves.toBe("second");
  });

  it("noteGet returns undefined for missing path", async () => {
    await expect(noteGet(DEFAULT_VAULT, "no-such-note.md")).resolves.toBeUndefined();
  });

  it("notePut + noteGet roundtrip", async () => {
    await notePut(DEFAULT_VAULT, "test.md", "# Hello", 1000, ["alpha"]);
    const note = await noteGet(DEFAULT_VAULT, "test.md");
    expect(note).toStrictEqual({ content: "# Hello", mtime: 1000, tags: [] });
  });

  it("noteGet derives tags from frontmatter", async () => {
    await notePut(
      DEFAULT_VAULT,
      "frontmatter.md",
      "---\ntags: [alpha, beta]\n---\n\n# Hello",
      1000,
      ["stale"],
    );
    const note = await noteGet(DEFAULT_VAULT, "frontmatter.md");
    expect(note).toStrictEqual({
      content: "---\ntags: [alpha, beta]\n---\n\n# Hello",
      mtime: 1000,
      tags: ["alpha", "beta"],
    });
  });

  it("notePut overwrites existing note", async () => {
    await notePut(DEFAULT_VAULT, "overwrite.md", "v1", 1000, []);
    await notePut(DEFAULT_VAULT, "overwrite.md", "v2", 2000, ["beta"]);
    await expect(noteGet(DEFAULT_VAULT, "overwrite.md")).resolves.toStrictEqual({
      content: "v2",
      mtime: 2000,
      tags: [],
    });
  });

  it("noteDel removes a cached note", async () => {
    await notePut(DEFAULT_VAULT, "delete-me.md", "bye", 1000, []);
    await noteDel(DEFAULT_VAULT, "delete-me.md");
    await expect(noteGet(DEFAULT_VAULT, "delete-me.md")).resolves.toBeUndefined();
  });

  it("noteDel is a no-op for missing path", async () => {
    await noteDel(DEFAULT_VAULT, "never-existed.md");
  });

  it("scopes kv entries per vault cookie", async () => {
    sessionStorage.setItem("tansu_vault", "0");
    await kvPut(0, "session", { tabs: ["zero.md"] });

    sessionStorage.setItem("tansu_vault", "1");
    await expect(kvGet(1, "session")).resolves.toBeUndefined();
    await kvPut(1, "session", { tabs: ["one.md"] });

    await expect(kvGet<{ tabs: string[] }>(1, "session")).resolves.toStrictEqual({
      tabs: ["one.md"],
    });

    sessionStorage.setItem("tansu_vault", "0");
    await expect(kvGet<{ tabs: string[] }>(0, "session")).resolves.toStrictEqual({
      tabs: ["zero.md"],
    });
  });

  it("scopes cached notes per vault cookie", async () => {
    sessionStorage.setItem("tansu_vault", "0");
    await notePut(0, "shared.md", "# Zero", 1000, []);

    sessionStorage.setItem("tansu_vault", "1");
    await expect(noteGet(1, "shared.md")).resolves.toBeUndefined();
    await notePut(1, "shared.md", "# One", 2000, []);
    await expect(noteGet(1, "shared.md")).resolves.toStrictEqual({
      content: "# One",
      mtime: 2000,
      tags: [],
    });

    sessionStorage.setItem("tansu_vault", "0");
    await expect(noteGet(0, "shared.md")).resolves.toStrictEqual({
      content: "# Zero",
      mtime: 1000,
      tags: [],
    });
  });
});

describe("local-store graceful degradation (no openStore)", () => {
  // These test the guards that return early when db is null.
  // closeStore was called in the previous describe's afterAll,
  // so db is null here.

  it("kvGet returns undefined", async () => {
    await expect(kvGet(DEFAULT_VAULT, "anything")).resolves.toBeUndefined();
  });

  it("kvPut is a silent no-op", async () => {
    await kvPut(DEFAULT_VAULT, "key", "val");
    // No throw
  });

  it("noteGet returns undefined", async () => {
    await expect(noteGet(DEFAULT_VAULT, "note.md")).resolves.toBeUndefined();
  });

  it("notePut is a silent no-op", async () => {
    await notePut(DEFAULT_VAULT, "note.md", "content", 1000, []);
  });

  it("noteDel is a silent no-op", async () => {
    await noteDel(DEFAULT_VAULT, "note.md");
  });
});
