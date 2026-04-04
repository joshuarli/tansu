import { setupDOM, assertEqual, assert, mockFetch } from "./test-helper.ts";
const cleanup = setupDOM();
const mock = mockFetch();

// tabs.ts needs API mocks at import time
mock.on("PUT", "/api/state", {});
mock.on("GET", "/api/state", { tabs: [], active: -1 });

const { handleBlockTransform } = await import("./transforms.ts");

function makeContentEl(): HTMLElement {
  const el = document.createElement("div");
  el.className = "editor-content";
  el.contentEditable = "true";
  document.body.appendChild(el);
  return el;
}

function simulateTransform(contentEl: HTMLElement, text: string): { prevented: boolean } {
  const p = document.createElement("p");
  p.textContent = text;
  contentEl.appendChild(p);

  // Place cursor inside the paragraph
  const range = document.createRange();
  const textNode = p.firstChild ?? p;
  range.setStart(textNode, text.length);
  range.collapse(true);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);

  let prevented = false;
  const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true });
  Object.defineProperty(event, "preventDefault", {
    value: () => {
      prevented = true;
    },
  });
  handleBlockTransform(event, contentEl, "test.md");
  return { prevented };
}

// Heading transform
{
  const el = makeContentEl();
  const { prevented } = simulateTransform(el, "## Hello");
  assert(prevented, "heading prevented default");
  const h2 = el.querySelector("h2");
  assert(h2 !== null, "h2 created");
  assertEqual(h2!.textContent, "Hello", "h2 text");
  // Paragraph added after heading
  const p = h2!.nextElementSibling;
  assert(p !== null && p.tagName === "P", "p after heading");
  el.remove();
}

// HR transform
{
  const el = makeContentEl();
  const { prevented } = simulateTransform(el, "---");
  assert(prevented, "hr prevented default");
  assert(el.querySelector("hr") !== null, "hr created");
  el.remove();
}

// Code block transform
{
  const el = makeContentEl();
  const { prevented } = simulateTransform(el, "```js");
  assert(prevented, "code prevented default");
  const pre = el.querySelector("pre");
  assert(pre !== null, "pre created");
  const code = pre!.querySelector("code");
  assert(code !== null, "code created");
  assertEqual(code!.className, "language-js", "code lang class");
  el.remove();
}

// UL transform
{
  const el = makeContentEl();
  const { prevented } = simulateTransform(el, "- item");
  assert(prevented, "ul prevented default");
  const ul = el.querySelector("ul");
  assert(ul !== null, "ul created");
  const li = ul!.querySelector("li");
  assertEqual(li!.textContent, "item", "li text");
  el.remove();
}

// OL transform
{
  const el = makeContentEl();
  const { prevented } = simulateTransform(el, "1. first");
  assert(prevented, "ol prevented default");
  const ol = el.querySelector("ol");
  assert(ol !== null, "ol created");
  assertEqual(ol!.querySelector("li")!.textContent, "first", "ol li text");
  el.remove();
}

// Blockquote transform
{
  const el = makeContentEl();
  const { prevented } = simulateTransform(el, "> quoted");
  assert(prevented, "bq prevented default");
  const bq = el.querySelector("blockquote");
  assert(bq !== null, "blockquote created");
  assertEqual(bq!.querySelector("p")!.textContent, "quoted", "bq text");
  el.remove();
}

// No transform for normal text
{
  const el = makeContentEl();
  const { prevented } = simulateTransform(el, "just text");
  assert(!prevented, "normal text not prevented");
  el.remove();
}

mock.restore();
cleanup();
console.log("All transforms tests passed");
