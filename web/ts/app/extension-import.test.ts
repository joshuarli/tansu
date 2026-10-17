import { describe, expect, it, vi } from "vitest";
import {
  MAX_IMAGE_BYTES,
  decodeImportMessage,
  importTitle,
  isTrustedSender,
  rewriteImageTokens,
  type ImportImage,
} from "./extension-import.ts";
import { importRequest as runImport, localizeImages } from "./extension-import-receiver.ts";

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    channel: "tansu",
    version: 1,
    type: "import.request",
    requestId: "r1",
    title: "T",
    markdown: "# T",
    sourceUrl: "https://example.com/a",
    images: [],
    ...overrides,
  };
}

const image = (id: number, base64: string | null = null): ImportImage => ({
  id,
  url: `https://example.com/${id}.png`,
  contentType: "image/png",
  base64,
});

describe("decodeImportMessage", () => {
  it("accepts a well-formed request", () => {
    const message = decodeImportMessage(request({ images: [image(0, "AAAA")] }));
    expect(message).toMatchObject({ kind: "request", request: { requestId: "r1", images: [{ id: 0 }] } });
  });

  it("ignores unrelated messages and answers pings", () => {
    expect(decodeImportMessage(null)).toBeNull();
    expect(decodeImportMessage({ channel: "other", type: "import.request" })).toBeNull();
    expect(decodeImportMessage(request({ requestId: 3 }))).toBeNull();
    expect(decodeImportMessage({ channel: "tansu", type: "import.ping" })).toEqual({ kind: "ping" });
  });

  it.each([
    ["version", { version: 2 }],
    ["title", { title: 1 }],
    ["markdown", { markdown: null }],
    ["sourceUrl scheme", { sourceUrl: "javascript:alert(1)" }],
    ["images shape", { images: {} }],
    ["image id", { images: [{ ...image(0), id: 5 }] }],
    ["image url", { images: [{ ...image(0), url: "data:image/png;base64,AA" }] }],
    ["image base64", { images: [{ ...image(0), base64: 7 }] }],
    ["image contentType", { images: [{ ...image(0), contentType: undefined }] }],
  ])("rejects an invalid %s", (_name, overrides) => {
    expect(decodeImportMessage(request(overrides))).toMatchObject({ kind: "invalid", requestId: "r1" });
  });

  it("enforces the size caps", () => {
    const base64OfBytes = (bytes: number) => "A".repeat(Math.ceil(bytes / 3) * 4);
    expect(decodeImportMessage(request({ markdown: "x".repeat(5 * 1024 * 1024 + 1) }))).toMatchObject({ kind: "invalid" });
    expect(decodeImportMessage(request({ images: [image(0, base64OfBytes(MAX_IMAGE_BYTES + 3))] }))).toMatchObject({ kind: "invalid" });
    const nine = base64OfBytes(9 * 1024 * 1024);
    const images = [0, 1, 2, 3, 4].map((id) => image(id, nine));
    expect(decodeImportMessage(request({ images }))).toMatchObject({ kind: "invalid", error: expect.stringContaining("40 MB") });
    expect(decodeImportMessage(request({ images: images.slice(0, 4) }))).toMatchObject({ kind: "request" });
  });
});

describe("isTrustedSender", () => {
  const page = { location: { origin: "https://tansu.test" } };
  it("requires the same window and origin", () => {
    expect(isTrustedSender({ source: page, origin: "https://tansu.test" }, page)).toBe(true);
    expect(isTrustedSender({ source: {}, origin: "https://tansu.test" }, page)).toBe(false);
    expect(isTrustedSender({ source: page, origin: "https://evil.test" }, page)).toBe(false);
  });
});

describe("rewriteImageTokens", () => {
  const images = [image(0), image(1), image(2)];

  it("substitutes localized images and restores remote URLs for failures", () => {
    const markdown = "![a](tansu-import-image:0) and ![b](tansu-import-image:1)";
    expect(rewriteImageTokens(markdown, images, [{ markdown: "![[x.webp]]" }, null]))
      .toBe("![[x.webp]] and ![b](https://example.com/1.png)");
  });

  it("keeps alt text containing brackets and escapes", () => {
    const markdown = "![a [b] \\] c](tansu-import-image:1)\n![](tansu-import-image:2)";
    expect(rewriteImageTokens(markdown, images, [null, null, null]))
      .toBe("![a [b] \\] c](https://example.com/1.png)\n![](https://example.com/2.png)");
  });

  it("does not let one embed swallow a neighbouring image", () => {
    const markdown = "![a](https://x.test/a.png) ![b](tansu-import-image:0)";
    expect(rewriteImageTokens(markdown, images, [{ markdown: "![[z.webp]]" }]))
      .toBe("![a](https://x.test/a.png) ![[z.webp]]");
  });

  it("never leaves a token behind and escapes parentheses in URLs", () => {
    const odd = [{ ...image(0), url: "https://example.com/a_(1).png" }];
    expect(rewriteImageTokens("![n [x](y)](tansu-import-image:0) ![](tansu-import-image:9)", odd, []))
      .toBe("![n [x](y)](https://example.com/a_%281%29.png) ![]()");
  });
});

describe("importTitle", () => {
  it("falls back to the source host and then a fixed title", () => {
    expect(importTitle({ title: " A\n title ", sourceUrl: "https://example.com/x" })).toBe("A title");
    expect(importTitle({ title: "  ", sourceUrl: "https://example.com/x" })).toBe("example.com");
    expect(importTitle({ title: "", sourceUrl: "not a url" })).toBe("Imported");
  });
});

describe("localizeImages", () => {
  const png = btoa("png");
  const host = (overrides: Partial<Parameters<typeof localizeImages>[1]> = {}) => ({
    imageWebpQuality: () => 0.5,
    convertToWebp: vi.fn(async (blob: Blob) => new Blob([blob], { type: "image/webp" })),
    uploadImage: vi.fn(async () => ({ name: "z-images/a.webp", markdown: "![[a.webp]]" })),
    ...overrides,
  });

  it("limits concurrency to four and tolerates individual failures", async () => {
    let running = 0;
    let peak = 0;
    const slow = host({
      uploadImage: vi.fn(async () => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 5));
        running -= 1;
        return { name: "z-images/a.webp", markdown: "![[a.webp]]" };
      }),
    });
    const images = Array.from({ length: 10 }, (_, id) => image(id, png));
    images[3] = { ...images[3]!, contentType: "image/svg+xml" };
    images[4] = image(4, "not base64!");
    const result = await localizeImages(images, slow, new AbortController().signal);
    expect(peak).toBe(4);
    expect(result.filter((entry) => entry === null)).toHaveLength(2);
    expect(result[3]).toBeNull();
    expect(result[4]).toBeNull();
  });

  it("treats conversion and upload errors as per-image failures but propagates aborts", async () => {
    const failing = host({ convertToWebp: vi.fn(async () => { throw new Error("no"); }) });
    expect(await localizeImages([image(0, png)], failing, new AbortController().signal)).toEqual([null]);
    const controller = new AbortController();
    const aborting = host({ uploadImage: vi.fn(async () => { controller.abort(); throw new Error("aborted"); }) });
    await expect(localizeImages([image(0, png)], aborting, controller.signal)).rejects.toThrow();
  });

  it("rejects an upload result that is not a WebP asset", async () => {
    const bad = host({ uploadImage: vi.fn(async () => ({ name: "elsewhere/a.png", markdown: "![[a.png]]" })) });
    expect(await localizeImages([image(0, png)], bad, new AbortController().signal)).toEqual([null]);
  });
});

describe("importRequest", () => {
  it("creates the note from rewritten markdown after localizing images", async () => {
    const createNote = vi.fn(async () => ({ noteId: "n1", path: "t.md" }));
    const message = decodeImportMessage(request({ markdown: "![a](tansu-import-image:0)", images: [image(0, btoa("x"))] }));
    if (message?.kind !== "request") throw new Error("expected a request");
    const result = await runImport(message.request, {
      isReady: () => true,
      imageWebpQuality: () => 0.5,
      convertToWebp: async (blob) => new Blob([blob], { type: "image/webp" }),
      uploadImage: async () => ({ name: "z-images/a.webp", markdown: "![[a.webp]]" }),
      createNote,
    }, new AbortController().signal);
    expect(createNote).toHaveBeenCalledWith({ title: "T", markdown: "![[a.webp]]" });
    expect(result).toMatchObject({ ok: true, noteId: "n1", imagesLocalized: 1, imagesFailed: 0 });
  });
});
