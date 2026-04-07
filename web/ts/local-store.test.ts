import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import "fake-indexeddb/auto";

import { openStore, closeStore, kvGet, kvPut, noteGet, notePut, noteDel } from "./local-store.ts";

describe("local-store", () => {
  beforeAll(async () => {
    await openStore();
  });

  afterAll(() => {
    closeStore();
  });

  test("kvGet returns undefined for missing key", async () => {
    expect(await kvGet("nonexistent")).toBeUndefined();
  });

  test("kvPut + kvGet roundtrip", async () => {
    await kvPut("test-key", { foo: "bar", n: 42 });
    const val = await kvGet<{ foo: string; n: number }>("test-key");
    expect(val).toEqual({ foo: "bar", n: 42 });
  });

  test("kvPut overwrites existing value", async () => {
    await kvPut("overwrite", "first");
    await kvPut("overwrite", "second");
    expect(await kvGet<string>("overwrite")).toBe("second");
  });

  test("noteGet returns undefined for missing path", async () => {
    expect(await noteGet("no-such-note.md")).toBeUndefined();
  });

  test("notePut + noteGet roundtrip", async () => {
    await notePut("test.md", "# Hello", 1000);
    const note = await noteGet("test.md");
    expect(note).toEqual({ content: "# Hello", mtime: 1000 });
  });

  test("notePut overwrites existing note", async () => {
    await notePut("overwrite.md", "v1", 1000);
    await notePut("overwrite.md", "v2", 2000);
    expect(await noteGet("overwrite.md")).toEqual({ content: "v2", mtime: 2000 });
  });

  test("noteDel removes a cached note", async () => {
    await notePut("delete-me.md", "bye", 1000);
    await noteDel("delete-me.md");
    expect(await noteGet("delete-me.md")).toBeUndefined();
  });

  test("noteDel is a no-op for missing path", async () => {
    await noteDel("never-existed.md");
  });
});

describe("local-store graceful degradation (no openStore)", () => {
  // These test the guards that return early when db is null.
  // closeStore was called in the previous describe's afterAll,
  // so db is null here.

  test("kvGet returns undefined", async () => {
    expect(await kvGet("anything")).toBeUndefined();
  });

  test("kvPut is a silent no-op", async () => {
    await kvPut("key", "val");
    // No throw
  });

  test("noteGet returns undefined", async () => {
    expect(await noteGet("note.md")).toBeUndefined();
  });

  test("notePut is a silent no-op", async () => {
    await notePut("note.md", "content", 1000);
  });

  test("noteDel is a silent no-op", async () => {
    await noteDel("note.md");
  });
});
