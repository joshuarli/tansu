import { beforeEach, vi, describe, expect, it } from "vitest";

import type { NoteMeta } from "./types.generated.ts";

const { pickHtmlImport } = await import("./html-import.ts");

describe("HTML import", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when the picker is cancelled", async () => {
    mockPickedFile(null);

    await expect(pickHtmlImport([])).resolves.toBeNull();
  });

  it("creates unique markdown with imported metadata", async () => {
    mockPickedFile(new File(["<article>body</article>"], "Saved Page.html", { type: "text/html" }));
    mockHtmlText(
      '<title>Saved Page</title><meta name="author" content="Ada"><meta property="og:site_name" content="Example"><meta name="date" content="2026-05-20"><meta name="description" content="Imported description"><article>Body text</article>',
    );

    await expect(
      pickHtmlImport([note("saved-page.md"), note("Saved Page.md")]),
    ).resolves.toStrictEqual({
      path: "Saved Page 2.md",
      content:
        "# Saved Page\n\nTitle: Saved Page\nAuthor: Ada\nSite: Example\nPublished: 2026-05-20\nDescription: Imported description\n\nBody text\n",
    });
  });

  it("falls back to the file name and rejects empty markdown", async () => {
    mockPickedFile(new File(["<article></article>"], "clip.htm", { type: "text/html" }));
    mockHtmlText("<title></title><article>  </article>");

    await expect(pickHtmlImport([])).resolves.toBeNull();
  });

  it("does not duplicate an existing top-level heading", async () => {
    mockPickedFile(new File(["<article>body</article>"], "clip.html", { type: "text/html" }));
    mockHtmlText("<title>Clip</title><article># Clip\n\nBody</article>");

    await expect(pickHtmlImport([])).resolves.toStrictEqual({
      path: "Clip.md",
      content: "Title: Clip\n\n# Clip\n\nBody\n",
    });
  });
});

function mockHtmlText(html: string): void {
  vi.spyOn(File.prototype, "text").mockResolvedValueOnce(html);
}

function mockPickedFile(file: File | null): void {
  const createElement = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementationOnce((tagName: string) => {
    const input = createElement(tagName) as HTMLInputElement;
    Object.defineProperty(input, "files", {
      value: file === null ? null : [file],
      configurable: true,
    });
    input.click = () => input.dispatchEvent(new Event("change"));
    return input;
  });
}

function note(path: string): NoteMeta {
  return {
    noteId: path,
    path,
    title: path,
    tags: [],
    seq: 1,
    contentHash: "hash",
    updatedAtMs: 1,
  };
}
