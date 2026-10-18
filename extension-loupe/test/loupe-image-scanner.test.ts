import assert from "node:assert/strict";
import { test } from "vitest";
import { findLoupeImageOccurrences, resolveLoupeImageUrl } from "../src/loupe-image-scanner.ts";

const SOURCE = "https://example.com/articles/hello";

test("detects a standard inline image embed", () => {
  const occurrences = findLoupeImageOccurrences("See ![photo](https://example.com/a.jpg) here.");

  assert.equal(occurrences.length, 1);
  assert.equal(occurrences[0]?.alt, "photo");
  assert.equal(occurrences[0]?.destination, "https://example.com/a.jpg");
});

test("does not mistake ordinary links for images", () => {
  assert.equal(findLoupeImageOccurrences("[text](https://example.com/a.jpg)").length, 0);
  assert.equal(findLoupeImageOccurrences("!![x](https://example.com/a.jpg)").length, 1);
});

test("does not treat escaped image syntax as an image", () => {
  assert.equal(findLoupeImageOccurrences(String.raw`\![x](https://example.com/a.jpg)`).length, 0);
  assert.equal(findLoupeImageOccurrences(String.raw`\\![x](https://example.com/a.jpg)`).length, 1);
});

test("ignores wikilink embeds", () => {
  assert.equal(findLoupeImageOccurrences("See ![[foo.webp]] here.").length, 0);
});

test("tolerates an empty alt string", () => {
  const occurrences = findLoupeImageOccurrences("![](https://example.com/a.jpg)");

  assert.equal(occurrences.length, 1);
  assert.equal(occurrences[0]?.alt, "");
});

test("supports angle-bracket destinations and optional titles", () => {
  const occurrences = findLoupeImageOccurrences(
    '![a](<https://example.com/a b.jpg> "A title") and ![b](https://example.com/c.jpg \'t\')',
  );

  assert.equal(occurrences.length, 2);
  assert.equal(occurrences[0]?.destination, "https://example.com/a b.jpg");
  assert.equal(occurrences[1]?.destination, "https://example.com/c.jpg");
});

test("does not truncate URLs containing parentheses", () => {
  const occurrences = findLoupeImageOccurrences(
    String.raw`![a](https://example.com/img_(1).jpg) ![b](https://example.com/a\(b\).jpg)`,
  );

  assert.equal(occurrences.length, 2);
  assert.equal(occurrences[0]?.destination, "https://example.com/img_(1).jpg");
  assert.equal(
    resolveLoupeImageUrl(occurrences[1]?.destination ?? "", SOURCE),
    "https://example.com/a(b).jpg",
  );
});

test("ignores image syntax inside fenced code", () => {
  const markdown = [
    "```markdown",
    "![code](https://example.com/code.jpg)",
    "```",
    "",
    "~~~",
    "![tilde](https://example.com/tilde.jpg)",
    "~~~",
    "",
    "![real](https://example.com/real.jpg)",
  ].join("\n");

  assert.deepEqual(
    findLoupeImageOccurrences(markdown).map((occurrence) => occurrence.destination),
    ["https://example.com/real.jpg"],
  );
});

test("ignores image syntax inside inline code", () => {
  const occurrences = findLoupeImageOccurrences(
    "`![code](https://example.com/code.jpg)` and ``![more](https://example.com/m.jpg)``",
  );

  assert.equal(occurrences.length, 0);
});

test("resolves relative destinations against the source page", () => {
  assert.equal(
    resolveLoupeImageUrl("/images/a.jpg", SOURCE),
    "https://example.com/images/a.jpg",
  );
  assert.equal(
    resolveLoupeImageUrl("../up.jpg", "https://example.com/articles/2024/hello"),
    "https://example.com/articles/up.jpg",
  );
});

test("resolves protocol-relative destinations", () => {
  assert.equal(
    resolveLoupeImageUrl("//cdn.example.com/a.jpg", SOURCE),
    "https://cdn.example.com/a.jpg",
  );
});

test("leaves non-web destinations alone", () => {
  for (const destination of [
    "",
    "#fragment",
    "data:image/png;base64,AAAA",
    "file:///tmp/a.jpg",
    "javascript:alert(1)",
    "obsidian://open?vault=x",
  ]) {
    assert.equal(resolveLoupeImageUrl(destination, SOURCE), null, destination);
  }
});
