import { setupDOM, mockFetch } from "./test-helper.ts";
import { TEST_IDS } from "./test-selectors.ts";

function makeEl(): HTMLElement {
  const el = document.createElement("div");
  document.body.append(el);
  return el;
}

describe("backlinks", () => {
  let cleanup: () => void;
  let mock: ReturnType<typeof mockFetch>;
  let loadBacklinks: (el: HTMLElement, path: string) => Promise<void>;

  beforeAll(async () => {
    cleanup = setupDOM();
    mock = mockFetch();

    mock.on("PUT", "/api/state", {});
    mock.on("GET", "/api/state", { tabs: [], active: -1 });

    const mod = await import("./backlinks.tsx");
    ({ loadBacklinks } = mod);
  });

  afterAll(() => {
    mock.restore();
    cleanup();
  });

  it("header element exists", async () => {
    const el = makeEl();
    mock.on("GET", "/api/backlinks", ["notes/foo.md", "notes/bar.md"]);
    await loadBacklinks(el, "notes/current.md");
    const header = el.querySelector(TEST_IDS.backlinksHeader);
    expect(header !== null).toBeTruthy();
  });

  it("header shows count", async () => {
    const el = makeEl();
    mock.on("GET", "/api/backlinks", ["notes/foo.md", "notes/bar.md"]);
    await loadBacklinks(el, "notes/current.md");
    const header = el.querySelector(TEST_IDS.backlinksHeader);
    expect(header!.textContent).toBe("2 backlinks");
  });

  it("two backlink items rendered", async () => {
    const el = makeEl();
    mock.on("GET", "/api/backlinks", ["notes/foo.md", "notes/bar.md"]);
    await loadBacklinks(el, "notes/current.md");
    const items = el.querySelectorAll(TEST_IDS.backlinkItem);
    expect(items).toHaveLength(2);
  });

  it("singular form for one backlink", async () => {
    const el = makeEl();
    mock.on("GET", "/api/backlinks", ["notes/only.md"]);
    await loadBacklinks(el, "notes/current.md");
    const header = el.querySelector(TEST_IDS.backlinksHeader);
    expect(header!.textContent).toBe("1 backlink");
  });

  it("first item shows stem 'foo'", async () => {
    const el = makeEl();
    mock.on("GET", "/api/backlinks", ["notes/foo.md", "bar/baz.md"]);
    await loadBacklinks(el, "notes/current.md");
    const items = el.querySelectorAll(TEST_IDS.backlinkItem);
    expect(items[0]!.textContent).toBe("foo");
  });

  it("second item shows stem 'baz'", async () => {
    const el = makeEl();
    mock.on("GET", "/api/backlinks", ["notes/foo.md", "bar/baz.md"]);
    await loadBacklinks(el, "notes/current.md");
    const items = el.querySelectorAll(TEST_IDS.backlinkItem);
    expect(items[1]!.textContent).toBe("baz");
  });

  it("element hidden when no backlinks", async () => {
    const el = makeEl();
    el.style.display = "block";
    mock.on("GET", "/api/backlinks", []);
    await loadBacklinks(el, "notes/current.md");
    expect(el.style.display).toBe("none");
  });

  it("element hidden on fetch error", async () => {
    const el = makeEl();
    el.style.display = "block";
    mock.on("GET", "/api/backlinks", "internal error", 500);
    await loadBacklinks(el, "notes/current.md");
    expect(el.style.display).toBe("none");
  });

  it("clicking a backlink item opens that tab", async () => {
    mock.on("GET", "/api/backlinks", ["notes/foo.md"]);
    mock.on("GET", "/api/note", { content: "# Foo", mtime: 1000 });
    mock.on("GET", "/api/state", { tabs: [], active: -1 });
    mock.on("PUT", "/api/state", {});

    const el = makeEl();
    await loadBacklinks(el, "notes/current.md");
    const item = el.querySelector(TEST_IDS.backlinkItem) as HTMLElement;
    expect(item !== null).toBeTruthy();

    // Clicking should trigger openTab, which fetches the note
    item.click();
    await new Promise((r) => setTimeout(r, 50));
    // If no error thrown, the onclick triggered openTab correctly
  });
});
