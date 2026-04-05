import { setupDOM, assertEqual, assert, mockFetch } from "./test-helper.ts";
const cleanup = setupDOM();
const mock = mockFetch();

mock.on("PUT", "/api/state", {});
mock.on("GET", "/api/state", { tabs: [], active: -1 });

const { loadBacklinks } = await import("./backlinks.ts");

function makeEl(): HTMLElement {
  const el = document.createElement("div");
  document.body.appendChild(el);
  return el;
}

// Renders header with count and items
{
  const el = makeEl();
  mock.on("GET", "/api/backlinks", ["notes/foo.md", "notes/bar.md"]);
  await loadBacklinks(el, "notes/current.md");
  const header = el.querySelector(".backlinks-header");
  assert(header !== null, "header element exists");
  assertEqual(header!.textContent, "2 backlinks", "header shows count");
  const items = el.querySelectorAll(".backlink-item");
  assertEqual(items.length, 2, "two backlink items rendered");
}

// Singular "1 backlink" vs plural "2 backlinks"
{
  const el = makeEl();
  mock.on("GET", "/api/backlinks", ["notes/only.md"]);
  await loadBacklinks(el, "notes/current.md");
  const header = el.querySelector(".backlinks-header");
  assertEqual(header!.textContent, "1 backlink", "singular form for one backlink");
}

// Items show stem from path (e.g. "notes/foo.md" → "foo")
{
  const el = makeEl();
  mock.on("GET", "/api/backlinks", ["notes/foo.md", "bar/baz.md"]);
  await loadBacklinks(el, "notes/current.md");
  const items = el.querySelectorAll(".backlink-item");
  assertEqual(items[0]!.textContent, "foo", "first item shows stem 'foo'");
  assertEqual(items[1]!.textContent, "baz", "second item shows stem 'baz'");
}

// Empty backlinks: hides the element
{
  const el = makeEl();
  el.style.display = "block";
  mock.on("GET", "/api/backlinks", []);
  await loadBacklinks(el, "notes/current.md");
  assertEqual(el.style.display, "none", "element hidden when no backlinks");
}

// API error: hides the element gracefully
{
  const el = makeEl();
  el.style.display = "block";
  mock.on("GET", "/api/backlinks", "internal error", 500);
  await loadBacklinks(el, "notes/current.md");
  assertEqual(el.style.display, "none", "element hidden on fetch error");
}

mock.restore();
cleanup();
console.log("All backlinks tests passed");
