import { setupDOM, mockFetch } from "./test-helper.ts";

function makeItem(file: File | null): DataTransferItem {
  return {
    type: "image/png",
    kind: "file",
    getAsFile: () => file,
    getAsString: () => {},
    webkitGetAsEntry: () => null,
  } as DataTransferItem;
}

describe("image-paste", () => {
  let cleanup: () => void;
  let mock: ReturnType<typeof mockFetch>;
  let handleImagePaste: (item: DataTransferItem, currentPath: string | null) => Promise<void>;
  const execCommandCalls: string[] = [];

  beforeAll(async () => {
    cleanup = setupDOM();
    mock = mockFetch();

    mock.on("PUT", "/api/state", {});
    mock.on("GET", "/api/state", { tabs: [], active: -1 });
    mock.on("POST", "/api/image", { filename: "test-image.webp" });

    const g = globalThis as unknown as Record<string, unknown>;

    // Mock createImageBitmap — not available in happy-dom
    g["createImageBitmap"] = async () => ({
      width: 100,
      height: 100,
      close: () => void 0,
    });

    // Mock OffscreenCanvas — happy-dom's version lacks convertToBlob
    g["OffscreenCanvas"] = class {
      width: number;
      height: number;
      constructor(w: number, h: number) {
        this.width = w;
        this.height = h;
      }
      getContext() {
        return { drawImage: () => void 0 };
      }
      convertToBlob() {
        return Promise.resolve(new Blob(["fake"], { type: "image/webp" }));
      }
    };

    // Mock document.execCommand — happy-dom may not implement insertHTML
    (
      globalThis as unknown as { document: { execCommand: (cmd: string) => boolean } }
    ).document.execCommand = (cmd: string) => {
      execCommandCalls.push(cmd);
      return true;
    };

    const mod = await import("./image-paste.ts");
    ({ handleImagePaste } = mod);
  });

  afterAll(() => {
    const g = globalThis as unknown as Record<string, unknown>;
    delete g["createImageBitmap"];
    delete g["OffscreenCanvas"];
    mock.restore();
    cleanup();
  });

  it("should call execCommand insertHTML after upload", async () => {
    const item = makeItem(new File(["data"], "screenshot.png", { type: "image/png" }));
    execCommandCalls.length = 0;
    await handleImagePaste(item, null);
    expect(execCommandCalls).toContain("insertHTML");
  });

  it("should do nothing when getAsFile returns null", async () => {
    const item = makeItem(null);
    execCommandCalls.length = 0;
    await handleImagePaste(item, null);
    expect(execCommandCalls).toHaveLength(0);
  });

  it("filename should include note stem", async () => {
    let capturedFilename: string | null = null;
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      let url: string;
      if (typeof input === "string") {
        url = input;
      } else if (input instanceof URL) {
        url = input.toString();
      } else {
        ({ url } = input as Request);
      }
      if (url.includes("/api/image") && init?.method === "POST") {
        capturedFilename = (init.headers as Record<string, string>)["X-Filename"] ?? null;
        return Response.json(
          { filename: "my-note 20260101120000.webp" },
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      return origFetch(input as RequestInfo, init);
    }) as typeof fetch;

    const item = makeItem(new File(["data"], "screenshot.png", { type: "image/png" }));
    await handleImagePaste(item, "notes/my-note.md");

    globalThis.fetch = origFetch;

    expect(capturedFilename !== null).toBeTruthy();
    expect(capturedFilename!).toContain("my-note");
    expect(capturedFilename!).toContain(".webp");
  });
});
