import assert from "node:assert/strict";
import { test } from "vitest";
import {
  createObsidianClipboardUri,
  createObsidianImportUri,
  createObsidianLoupeImportUri,
  sha256HexOfText,
} from "../src/obsidian-uri.ts";

test("creates an Obsidian clipboard import URI", () => {
  const uri = new URL(createObsidianClipboardUri("A title.md"));

  assert.equal(uri.protocol, "obsidian:");
  assert.equal(uri.hostname, "new");
  assert.equal(uri.searchParams.get("file"), "A title.md");
  assert.ok(uri.searchParams.has("clipboard"));
});

test("includes a clipboard fallback in an Obsidian clipboard import URI", () => {
  const uri = new URL(createObsidianClipboardUri());

  assert.ok(uri.searchParams.has("clipboard"));
  assert.ok(uri.searchParams.get("content")?.length);
});

test("percent-encodes spaces and sanitizes an Obsidian note name", () => {
  const uri = createObsidianClipboardUri("  foo/bar: baz  ");

  assert.match(uri, /file=foo-bar-%20baz&/);
  assert.equal(new URL(uri).searchParams.get("file"), "foo-bar- baz");
});

test("creates an Obsidian import URI containing the complete Markdown payload", () => {
  const markdown = "# Heading\n\nA & B? 100%",
    uri = new URL(createObsidianImportUri(markdown));

  assert.equal(uri.protocol, "obsidian:");
  assert.equal(uri.hostname, "new");
  assert.equal(uri.searchParams.get("content"), markdown);
});

test("includes a note name in an Obsidian Markdown import URI", () => {
  const uri = new URL(createObsidianImportUri("body", "A title.md"));

  assert.equal(uri.searchParams.get("file"), "A title.md");
});

test("percent-encodes Markdown spaces for Obsidian URL parsing", () => {
  assert.equal(
    createObsidianImportUri("# Heading\n\nA title", "Note"),
    "obsidian://new?file=Note&content=%23%20Heading%0A%0AA%20title",
  );
});

test("hashes text with lowercase hexadecimal SHA-256", async () => {
  assert.equal(
    await sha256HexOfText("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  assert.equal(
    await sha256HexOfText(""),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
});

test("creates a loupe-import URI with file, source, and sha256", () => {
  const sha256 = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    uri = new URL(createObsidianLoupeImportUri("A title.md", "https://example.com/a?b=c", sha256));

  assert.equal(uri.protocol, "obsidian:");
  assert.equal(uri.hostname, "loupe-import");
  assert.equal(uri.searchParams.get("file"), "A title.md");
  assert.equal(uri.searchParams.get("source"), "https://example.com/a?b=c");
  assert.equal(uri.searchParams.get("sha256"), sha256);
});

test("encodes loupe-import metadata as structured query parameters", () => {
  const source = "https://example.com/article?a=1&b=2#photos",
    uri = new URL(createObsidianLoupeImportUri("Article & notes", source, "a".repeat(64)));

  assert.equal(uri.searchParams.get("file"), "Article - notes");
  assert.equal(uri.searchParams.get("source"), source);
  assert.ok(!uri.search.includes("&b=2"));
});

test("sanitizes and encodes the loupe-import note name", () => {
  const uri = createObsidianLoupeImportUri(
      "  foo/bar: baz  ",
      "https://example.com/",
      "0".repeat(64),
    ),
    parsedUri = new URL(uri);
  assert.equal(parsedUri.searchParams.get("file"), "foo-bar- baz");
  assert.ok(!uri.includes("foo/bar"));
});

test("omits an empty note name from the loupe-import URI", () => {
  const uri = new URL(createObsidianLoupeImportUri("", "https://example.com/", "0".repeat(64)));

  assert.ok(!uri.searchParams.has("file"));
  assert.equal(uri.searchParams.get("source"), "https://example.com/");
});

test("never puts article Markdown into the loupe-import URI", () => {
  const uri = createObsidianLoupeImportUri("Note", "https://example.com/", "0".repeat(64));

  assert.ok(!uri.includes(encodeURIComponent("Heading")));
  assert.ok(!uri.includes("photo.jpg"));
  assert.ok(!uri.includes("content="));
});

test("keeps the content URI fallback carrying the complete Markdown payload", () => {
  const markdown = "# Heading\n\nA & B? 100%",
    uri = new URL(createObsidianImportUri(markdown));

  assert.equal(uri.hostname, "new");
  assert.equal(uri.searchParams.get("content"), markdown);
});
