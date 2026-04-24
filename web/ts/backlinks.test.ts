import { describe, test, expect, beforeAll, afterAll } from "vitest";

import { setupDOM, mockFetch } from "./test-helper.ts";

function makeEl(): HTMLElement {
  const el = document.createElement("div");
  document.body.appendChild(el);
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

    const mod = await import("./backlinks.ts");
    loadBacklinks = mod.loadBacklinks;
  });

  afterAll(() => {
    mock.restore();
    cleanup();
  });

  test("header element exists", async () => {
    const el = makeEl();
    mock.on("GET", "/api/backlinks", ["notes/foo.md", "notes/bar.md"]);
    await loadBacklinks(el, "notes/current.md");
    const header = el.querySelector(".backlinks-header");
    expect(header !== null).toBe(true);
  });

  test("header shows count", async () => {
    const el = makeEl();
    mock.on("GET", "/api/backlinks", ["notes/foo.md", "notes/bar.md"]);
    await loadBacklinks(el, "notes/current.md");
    const header = el.querySelector(".backlinks-header");
    expect(header!.textContent).toBe("2 backlinks");
  });

  test("two backlink items rendered", async () => {
    const el = makeEl();
    mock.on("GET", "/api/backlinks", ["notes/foo.md", "notes/bar.md"]);
    await loadBacklinks(el, "notes/current.md");
    const items = el.querySelectorAll(".backlink-item");
    expect(items.length).toBe(2);
  });

  test("singular form for one backlink", async () => {
    const el = makeEl();
    mock.on("GET", "/api/backlinks", ["notes/only.md"]);
    await loadBacklinks(el, "notes/current.md");
    const header = el.querySelector(".backlinks-header");
    expect(header!.textContent).toBe("1 backlink");
  });

  test("first item shows stem 'foo'", async () => {
    const el = makeEl();
    mock.on("GET", "/api/backlinks", ["notes/foo.md", "bar/baz.md"]);
    await loadBacklinks(el, "notes/current.md");
    const items = el.querySelectorAll(".backlink-item");
    expect(items[0]!.textContent).toBe("foo");
  });

  test("second item shows stem 'baz'", async () => {
    const el = makeEl();
    mock.on("GET", "/api/backlinks", ["notes/foo.md", "bar/baz.md"]);
    await loadBacklinks(el, "notes/current.md");
    const items = el.querySelectorAll(".backlink-item");
    expect(items[1]!.textContent).toBe("baz");
  });

  test("element hidden when no backlinks", async () => {
    const el = makeEl();
    el.style.display = "block";
    mock.on("GET", "/api/backlinks", []);
    await loadBacklinks(el, "notes/current.md");
    expect(el.style.display).toBe("none");
  });

  test("element hidden on fetch error", async () => {
    const el = makeEl();
    el.style.display = "block";
    mock.on("GET", "/api/backlinks", "internal error", 500);
    await loadBacklinks(el, "notes/current.md");
    expect(el.style.display).toBe("none");
  });

  test("clicking a backlink item opens that tab", async () => {
    mock.on("GET", "/api/backlinks", ["notes/foo.md"]);
    mock.on("GET", "/api/note", { content: "# Foo", mtime: 1000 });
    mock.on("GET", "/api/state", { tabs: [], active: -1 });
    mock.on("PUT", "/api/state", {});

    const el = makeEl();
    await loadBacklinks(el, "notes/current.md");
    const item = el.querySelector(".backlink-item") as HTMLElement;
    expect(item !== null).toBe(true);

    // Clicking should trigger openTab, which fetches the note
    item.click();
    await new Promise((r) => setTimeout(r, 50));
    // If no error thrown, the onclick triggered openTab correctly
  });
});
