import type { RevisionsOpts } from "./revisions.tsx";
import { setupDOM, mockFetch } from "./test-helper.ts";

describe("revisions", () => {
  let cleanup: () => void;
  let mock: ReturnType<typeof mockFetch>;
  let toggleRevisions: (opts: RevisionsOpts) => void;
  let hideRevisions: () => void;
  let isRevisionsOpen: () => boolean;
  let offRestore: () => void;
  let host: HTMLDivElement;

  function makeOpts(path: string) {
    let hideCalled = false;
    return {
      path,
      host,
      getCurrentContent: () => "current content",
      onHide: () => {
        hideCalled = true;
      },
      get hideCalled() {
        return hideCalled;
      },
      set hideCalled(v: boolean) {
        hideCalled = v;
      },
    };
  }

  beforeAll(async () => {
    cleanup = setupDOM();
    mock = mockFetch();

    mock.on("GET", /\/api\/revisions\?/, [1000, 2000, 3000]);
    mock.on("GET", /\/api\/revision\?/, { content: "# Old version" });
    mock.on("POST", "/api/restore", { mtime: 5000 });

    const revMod = await import("./revisions.tsx");
    ({ toggleRevisions } = revMod);
    ({ hideRevisions } = revMod);
    ({ isRevisionsOpen } = revMod);

    const { on } = await import("./events.ts");
    offRestore = on("revision:restore", () => {});

    host = document.createElement("div");
    host.className = "revisions-container";
    document.body.append(host);
  });

  afterAll(() => {
    host.remove();
    mock.restore();
    offRestore();
    cleanup();
  });

  it("revisions lifecycle", async () => {
    // Show revisions
    let opts = makeOpts("test.md");
    toggleRevisions(opts);
    await new Promise((r) => setTimeout(r, 200));

    // Header
    const header = host.querySelector(".revisions-header");
    expect(header !== null).toBeTruthy();
    expect(header!.textContent!).toContain("Revisions");

    // Revision items
    const items = host.querySelectorAll(".revision-item");
    expect(items).toHaveLength(3);

    // Each item has a restore button
    const restoreBtn = items[0]!.querySelector(".restore-btn");
    expect(restoreBtn !== null).toBeTruthy();
    expect(restoreBtn!.textContent).toBe("Restore");

    // Hide revisions
    opts.hideCalled = false;
    hideRevisions();
    expect(isRevisionsOpen()).toBeFalsy();
    expect(opts.hideCalled).toBeTruthy();
    expect(host.innerHTML).toBe("");

    // Toggle: show then toggle again hides
    opts = makeOpts("test.md");
    toggleRevisions(opts);
    await new Promise((r) => setTimeout(r, 200));
    expect(isRevisionsOpen()).toBeTruthy();
    opts.hideCalled = false;
    toggleRevisions(opts);
    expect(isRevisionsOpen()).toBeFalsy();
    expect(opts.hideCalled).toBeTruthy();

    // Toggle different path shows new panel
    opts = makeOpts("a.md");
    toggleRevisions(opts);
    await new Promise((r) => setTimeout(r, 200));
    expect(isRevisionsOpen()).toBeTruthy();
    hideRevisions();
  });

  it("clicking restore button emits revision:restore", async () => {
    const { on } = await import("./events.ts");

    let restoreEvent: { content: string; mtime: number } | null = null;
    const offR = on("revision:restore", (data) => {
      restoreEvent = data;
    });

    const opts = makeOpts("test.md");
    toggleRevisions(opts);
    await new Promise((r) => setTimeout(r, 200));

    const restoreBtn = host.querySelector(".restore-btn") as HTMLElement;
    expect(restoreBtn !== null).toBeTruthy();

    // confirm is already mocked to return true by setupDOM
    // Use dispatchEvent instead of click() for happy-dom compatibility
    restoreBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    // The onclick handler is async — needs enough time for two fetch calls
    await new Promise((r) => setTimeout(r, 500));

    expect(restoreEvent !== null).toBeTruthy();
    expect(restoreEvent!.content).toBe("# Old version");
    expect(restoreEvent!.mtime).toBe(5000);

    offR();
    // Panel is hidden after restore
    expect(isRevisionsOpen()).toBeFalsy();
  });

  it("empty revisions shows 'No revisions yet.' message", async () => {
    // Mock empty revisions list
    mock.on("GET", /\/api\/revisions\?/, []);

    const opts = makeOpts("empty.md");
    toggleRevisions(opts);
    await new Promise((r) => setTimeout(r, 200));

    expect(isRevisionsOpen()).toBeTruthy();
    expect(host.querySelectorAll(".revision-item")).toHaveLength(0);
    expect(host.textContent).toContain("No revisions yet.");

    hideRevisions();

    // Restore original mock
    mock.on("GET", /\/api\/revisions\?/, [1000, 2000, 3000]);
  });

  it("clicking a revision item shows diff preview", async () => {
    const opts = makeOpts("test.md");
    toggleRevisions(opts);
    await new Promise((r) => setTimeout(r, 200));

    const items = host.querySelectorAll(".revision-item");
    expect(items).toHaveLength(3);

    // Click the first revision item (not the restore button)
    (items[0] as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 200));

    const preview = host.querySelector(".revision-preview");
    expect(preview !== null).toBeTruthy();
    expect(preview!.classList.contains("diff-view")).toBeTruthy();

    hideRevisions();
  });
});
