import { setupDOM, assert, assertContains, mockFetch } from "./test-helper.ts";
const cleanup = setupDOM();
const mock = mockFetch();

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
  constructor(public width: number, public height: number) {}
  getContext() {
    return { drawImage: () => {} };
  }
  convertToBlob() {
    return Promise.resolve(new Blob(["fake"], { type: "image/webp" }));
  }
};

// Mock document.execCommand — happy-dom may not implement insertHTML
const execCommandCalls: string[] = [];
(globalThis as any).document.execCommand = (cmd: string) => {
  execCommandCalls.push(cmd);
  return true;
};

const { handleImagePaste } = await import("./image-paste.ts");

function makeItem(file: File | null): DataTransferItem {
  return {
    type: "image/png",
    kind: "file",
    getAsFile: () => file,
    getAsString: () => {},
    webkitGetAsEntry: () => null,
  } as DataTransferItem;
}

// Test 1: uploads image and inserts HTML without throwing
{
  const item = makeItem(new File(["data"], "screenshot.png", { type: "image/png" }));
  execCommandCalls.length = 0;
  await handleImagePaste(item, null);
  assert(execCommandCalls.includes("insertHTML"), "should call execCommand insertHTML after upload");
}

// Test 2: null file (getAsFile returns null) does nothing
{
  const item = makeItem(null);
  execCommandCalls.length = 0;
  await handleImagePaste(item, null);
  assert(execCommandCalls.length === 0, "should do nothing when getAsFile returns null");
}

// Test 3: filename includes note stem when currentPath is provided
{
  let capturedFilename: string | null = null;
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
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

  assert(capturedFilename !== null, "should have sent upload request");
  assertContains(capturedFilename!, "my-note", "filename should include note stem");
  assertContains(capturedFilename!, ".webp", "filename should end in .webp");
}

// Tear down
delete (globalThis as any).createImageBitmap;
delete (globalThis as any).OffscreenCanvas;
mock.restore();
cleanup();
console.log("All image-paste tests passed");
