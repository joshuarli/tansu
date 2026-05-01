import type { RevisionsOpts } from "./revisions.tsx";
import { setupDOM, mockFetch } from "./test-helper.ts";
import { TEST_IDS } from "./test-selectors.ts";

describe("revisions", () => {
  let cleanup: () => void;
  let mock: ReturnType<typeof mockFetch>;
  let toggleRevisions: (opts: RevisionsOpts) => void;
  let hideRevisions: () => void;
  let isRevisionsOpen: () => boolean;
  let host: HTMLDivElement;

  function makeOpts(path: string) {
    let hideCalled = false;
    const opts: RevisionsOpts & { hideCalled: boolean } = {
      path,
      host,
      getCurrentContent: () => "current content",
      onRestoreRevision: () => {},
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
    return opts;
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

    host = document.createElement("div");
    host.dataset["ui"] = "revisions-container";
    document.body.append(host);
  });

  afterAll(() => {
    host.remove();
    mock.restore();
    cleanup();
  });

  it("revisions lifecycle", async () => {
    // Show revisions
    let opts = makeOpts("test.md");
    toggleRevisions(opts);
    await new Promise((r) => setTimeout(r, 200));

    // Header
    const header = host.querySelector(TEST_IDS.revisionsHeader);
    expect(header !== null).toBeTruthy();
    expect(header!.textContent!).toContain("Revisions");

    // Revision items
    const items = host.querySelectorAll(TEST_IDS.revisionItem);
    expect(items).toHaveLength(3);

    // Each item has a restore button
    const restoreBtn = items[0]!.querySelector(TEST_IDS.restoreButton);
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

  it("clicking restore button forwards the restored revision to the editor bridge", async () => {
    let restoreEvent: { content: string; mtime: number } | null = null;

    const opts = makeOpts("test.md");
    opts.onRestoreRevision = (content, mtime) => {
      restoreEvent = { content, mtime };
    };
    toggleRevisions(opts);
    await new Promise((r) => setTimeout(r, 200));

    const restoreBtn = host.querySelector(TEST_IDS.restoreButton) as HTMLElement;
    expect(restoreBtn !== null).toBeTruthy();

    // confirm is already mocked to return true by setupDOM
    // Use dispatchEvent instead of click() for happy-dom compatibility
    restoreBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    // The onclick handler is async — needs enough time for two fetch calls
    await new Promise((r) => setTimeout(r, 500));

    expect(restoreEvent !== null).toBeTruthy();
    expect(restoreEvent!.content).toBe("# Old version");
    expect(restoreEvent!.mtime).toBe(5000);

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
    expect(host.querySelectorAll(TEST_IDS.revisionItem)).toHaveLength(0);
    expect(host.textContent).toContain("No revisions yet.");

    hideRevisions();

    // Restore original mock
    mock.on("GET", /\/api\/revisions\?/, [1000, 2000, 3000]);
  });

  it("clicking a revision item shows diff preview", async () => {
    const opts = makeOpts("test.md");
    toggleRevisions(opts);
    await new Promise((r) => setTimeout(r, 200));

    const items = host.querySelectorAll(TEST_IDS.revisionItem);
    expect(items).toHaveLength(3);

    // Click the first revision item (not the restore button)
    (items[0] as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 200));

    const preview = host.querySelector(TEST_IDS.diffView);
    expect(preview !== null).toBeTruthy();
    expect(preview!.matches(TEST_IDS.diffView)).toBeTruthy();

    hideRevisions();
  });
});
