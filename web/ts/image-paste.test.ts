import { describe, test, expect, beforeAll, afterAll } from "bun:test";

import { setupDOM, mockFetch } from "./test-helper.ts";

describe("image-paste", () => {
  let cleanup: () => void;
  let mock: ReturnType<typeof mockFetch>;
  let handleImagePaste: (item: DataTransferItem, currentPath: string | null) => Promise<void>;
  const execCommandCalls: string[] = [];

  function makeItem(file: File | null): DataTransferItem {
    return {
      type: "image/png",
      kind: "file",
      getAsFile: () => file,
      getAsString: () => {},
      webkitGetAsEntry: () => null,
    } as DataTransferItem;
  }

  beforeAll(async () => {
    cleanup = setupDOM();
    mock = mockFetch();

    mock.on("PUT", "/api/state", {});
    mock.on("GET", "/api/state", { tabs: [], active: -1 });
    mock.on("POST", "/api/image", { filename: "test-image.webp" });

    // Mock createImageBitmap — not available in happy-dom
    (globalThis as any).createImageBitmap = async () => ({
      width: 100,
      height: 100,
      close: () => {},
    });

    // Mock OffscreenCanvas — happy-dom's version lacks convertToBlob
    (globalThis as any).OffscreenCanvas = class {
      constructor(
        public width: number,
        public height: number,
      ) {}
      getContext() {
        return { drawImage: () => {} };
      }
      convertToBlob() {
        return Promise.resolve(new Blob(["fake"], { type: "image/webp" }));
      }
    };

    // Mock document.execCommand — happy-dom may not implement insertHTML
    (globalThis as any).document.execCommand = (cmd: string) => {
      execCommandCalls.push(cmd);
      return true;
    };

    const mod = await import("./image-paste.ts");
    handleImagePaste = mod.handleImagePaste;
  });

  afterAll(() => {
    delete (globalThis as any).createImageBitmap;
    delete (globalThis as any).OffscreenCanvas;
    mock.restore();
    cleanup();
  });

  test("should call execCommand insertHTML after upload", async () => {
    const item = makeItem(new File(["data"], "screenshot.png", { type: "image/png" }));
    execCommandCalls.length = 0;
    await handleImagePaste(item, null);
    expect(execCommandCalls.includes("insertHTML")).toBe(true);
  });

  test("should do nothing when getAsFile returns null", async () => {
    const item = makeItem(null);
    execCommandCalls.length = 0;
    await handleImagePaste(item, null);
    expect(execCommandCalls.length).toBe(0);
  });

  test("filename should include note stem", async () => {
    let capturedFilename: string | null = null;
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      if (url.includes("/api/image") && init?.method === "POST") {
        capturedFilename = (init.headers as Record<string, string>)["X-Filename"] ?? null;
        return new Response(JSON.stringify({ filename: "my-note 20260101120000.webp" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return origFetch(input as RequestInfo, init);
    }) as typeof fetch;

    const item = makeItem(new File(["data"], "screenshot.png", { type: "image/png" }));
    await handleImagePaste(item, "notes/my-note.md");

    globalThis.fetch = origFetch;

    expect(capturedFilename !== null).toBe(true);
    expect(capturedFilename!).toContain("my-note");
    expect(capturedFilename!).toContain(".webp");
  });
});
