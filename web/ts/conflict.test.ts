import type { Tab } from "./tab-state.ts";
import { setupDOM, mockFetch } from "./test-helper.ts";

function makeContainer(): HTMLElement {
  const div = document.createElement("div");
  document.body.append(div);
  return div;
}

describe("conflict", () => {
  let cleanup: () => void;
  let mock: ReturnType<typeof mockFetch>;
  let showConflictBanner: (
    container: HTMLElement,
    path: string,
    diskContent: string,
    diskMtime: number,
    loadContent: (md: string) => void,
    getCurrentContent: () => string,
  ) => void;
  let handleReloadConflict: (
    tab: Tab,
    container: HTMLElement,
    path: string,
    diskContent: string,
    diskMtime: number,
    loadContent: (md: string) => void,
    getCurrentContent: () => string,
  ) => void;

  beforeAll(async () => {
    cleanup = setupDOM();
    mock = mockFetch();

    mock.on("PUT", "/api/note", { mtime: 2000 });
    mock.on("PUT", "/api/state", {});
    mock.on("GET", "/api/state", { tabs: [], active: -1 });

    // Import AFTER mocks so module-level fetches see them
    const mod = await import("./conflict.tsx");
    ({ showConflictBanner } = mod);
    ({ handleReloadConflict } = mod);
  });

  afterAll(() => {
    mock.restore();
    cleanup();
  });

  it("banner exists", () => {
    const container = makeContainer();
    showConflictBanner(
      container,
      "notes/a.md",
      "disk content",
      1000,
      () => {},
      () => "mine",
    );
    const banner = container.querySelector(".conflict-banner");
    expect(banner !== null).toBeTruthy();
  });

  it("message text correct", () => {
    const container = makeContainer();
    showConflictBanner(
      container,
      "notes/a.md",
      "disk content",
      1000,
      () => {},
      () => "mine",
    );
    const span = container.querySelector(".conflict-banner")!.querySelector("span");
    expect(span !== null).toBeTruthy();
    expect(span!.textContent!).toContain("File changed externally");
  });

  it("two buttons", () => {
    const container = makeContainer();
    showConflictBanner(
      container,
      "notes/a.md",
      "disk content",
      1000,
      () => {},
      () => "mine",
    );
    const buttons = container.querySelector(".conflict-banner")!.querySelectorAll("button");
    expect(buttons).toHaveLength(2);
    expect(buttons[0]!.textContent).toBe("Keep mine");
    expect(buttons[1]!.textContent).toBe("Take theirs");
  });

  it("banner removed after Keep mine", async () => {
    const container = makeContainer();
    showConflictBanner(
      container,
      "notes/b.md",
      "disk content",
      1000,
      () => {},
      () => "my content",
    );
    const banner = container.querySelector(".conflict-banner")!;
    const keepBtn = banner.querySelectorAll("button")[0]! as HTMLButtonElement;
    keepBtn.click();
    expect(container.querySelector(".conflict-banner")).toBeNull();
    // saveNote is async; give it a tick to fire the fetch
    await new Promise((r) => setTimeout(r, 10));
  });

  it("banner removed after Take theirs", () => {
    const container = makeContainer();
    let loadedWith = "";
    showConflictBanner(
      container,
      "notes/c.md",
      "their content",
      1500,
      (md) => {
        loadedWith = md;
      },
      () => "my content",
    );
    const banner = container.querySelector(".conflict-banner")!;
    const takeBtn = banner.querySelectorAll("button")[1]! as HTMLButtonElement;
    takeBtn.click();
    expect(container.querySelector(".conflict-banner")).toBeNull();
    expect(loadedWith).toBe("their content");
  });

  it("only one banner after calling twice", () => {
    const container = makeContainer();
    showConflictBanner(
      container,
      "notes/d.md",
      "first disk",
      1000,
      () => {},
      () => "mine",
    );
    showConflictBanner(
      container,
      "notes/d.md",
      "second disk",
      2000,
      () => {},
      () => "mine",
    );
    const banners = container.querySelectorAll(".conflict-banner");
    expect(banners).toHaveLength(1);
  });

  it("no banner on clean merge", () => {
    // base="a\nb", ours="a\nb\nc" (ours appended), theirs="x\na\nb" (theirs prepended)
    // merge3 should produce "x\na\nb\nc"
    const container = makeContainer();
    let loadedWith = "";
    const tab = {
      path: "notes/e.md",
      title: "e",
      content: "a\nb", // base: what was last known
      tags: [],
      mtime: 1000,
      dirty: true,
      lastSavedMd: "a\nb",
      lastSavedTags: [],
    };

    handleReloadConflict(
      tab,
      container,
      "notes/e.md",
      "x\na\nb", // theirs (disk)
      2000,
      (md) => {
        loadedWith = md;
      },
      () => "a\nb\nc", // ours (editor)
    );

    expect(container.querySelector(".conflict-banner")).toBeNull();
    expect(loadedWith).toBe("x\na\nb\nc");
    expect(tab.mtime).toBe(2000);
  });

  it("banner shown on conflict", () => {
    // base="a\nb", ours changed line 2 one way, theirs changed line 2 differently
    const container = makeContainer();
    let loadedWith = "";
    const tab = {
      path: "notes/f.md",
      title: "f",
      content: "a\nb",
      tags: [],
      mtime: 1000,
      dirty: true,
      lastSavedMd: "a\nb",
      lastSavedTags: [],
    };

    handleReloadConflict(
      tab,
      container,
      "notes/f.md",
      "a\nY", // theirs: changed line 2 to Y
      2000,
      (md) => {
        loadedWith = md;
      },
      () => "a\nX", // ours: changed line 2 to X — conflict
    );

    expect(container.querySelector(".conflict-banner") !== null).toBeTruthy();
    expect(loadedWith).toBe("");
  });
});
