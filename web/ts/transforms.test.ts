import { setupDOM, assertEqual, assert, mockFetch } from "./test-helper.ts";
const cleanup = setupDOM();
const mock = mockFetch();

// tabs.ts needs API mocks at import time
mock.on("PUT", "/api/state", {});
mock.on("GET", "/api/state", { tabs: [], active: -1 });

const { handleBlockTransform, checkBlockInputTransform } = await import("./transforms.ts");

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

// === Input-triggered (Space) transforms ===

function simulateInputTransform(contentEl: HTMLElement, text: string): boolean {
  const p = document.createElement("p");
  p.textContent = text;
  contentEl.appendChild(p);

  const range = document.createRange();
  const textNode = p.firstChild ?? p;
  range.setStart(textNode, text.length);
  range.collapse(true);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);

  return checkBlockInputTransform(contentEl);
}

// Heading input transform: "## " → H2
{
  const el = makeContentEl();
  assert(simulateInputTransform(el, "## "), "h2 input transform");
  const h2 = el.querySelector("h2");
  assert(h2 !== null, "h2 created via input");
  assertEqual(h2!.innerHTML, "<br>", "h2 empty with br");
  el.remove();
}

// Heading with nbsp (contentEditable inserts \u00A0)
{
  const el = makeContentEl();
  assert(simulateInputTransform(el, "##\u00A0"), "h2 nbsp input transform");
  assert(el.querySelector("h2") !== null, "h2 created via nbsp");
  el.remove();
}

// H1 input transform
{
  const el = makeContentEl();
  assert(simulateInputTransform(el, "# "), "h1 input transform");
  assert(el.querySelector("h1") !== null, "h1 created");
  el.remove();
}

// H3 input transform
{
  const el = makeContentEl();
  assert(simulateInputTransform(el, "### "), "h3 input transform");
  assert(el.querySelector("h3") !== null, "h3 created");
  el.remove();
}

// UL input transform: "- " → UL
{
  const el = makeContentEl();
  assert(simulateInputTransform(el, "- "), "ul input transform");
  const ul = el.querySelector("ul");
  assert(ul !== null, "ul created via input");
  const li = ul!.querySelector("li");
  assert(li !== null, "li created");
  assertEqual(li!.innerHTML, "<br>", "li empty with br");
  el.remove();
}

// UL with asterisk: "* " → UL
{
  const el = makeContentEl();
  assert(simulateInputTransform(el, "* "), "ul asterisk input transform");
  assert(el.querySelector("ul") !== null, "ul created via asterisk");
  el.remove();
}

// OL input transform: "1. " → OL
{
  const el = makeContentEl();
  assert(simulateInputTransform(el, "1. "), "ol input transform");
  const ol = el.querySelector("ol");
  assert(ol !== null, "ol created via input");
  el.remove();
}

// Blockquote input transform: "> " → blockquote
{
  const el = makeContentEl();
  assert(simulateInputTransform(el, "> "), "bq input transform");
  const bq = el.querySelector("blockquote");
  assert(bq !== null, "blockquote created via input");
  const p = bq!.querySelector("p");
  assert(p !== null, "p inside blockquote");
  assertEqual(p!.innerHTML, "<br>", "bq p empty with br");
  el.remove();
}

// Code block input transform: "``` " → pre>code
{
  const el = makeContentEl();
  assert(simulateInputTransform(el, "``` "), "code block input transform");
  const pre = el.querySelector("pre");
  assert(pre !== null, "pre created via input");
  const code = pre!.querySelector("code");
  assert(code !== null, "code created via input");
  el.remove();
}

// Code block with language: "```js " → pre>code.language-js
{
  const el = makeContentEl();
  assert(simulateInputTransform(el, "```js "), "code block lang input transform");
  const code = el.querySelector("code");
  assert(code !== null, "code element with lang");
  assertEqual(code!.className, "language-js", "code lang class via input");
  el.remove();
}

// Code block with nbsp
{
  const el = makeContentEl();
  assert(simulateInputTransform(el, "```\u00A0"), "code block nbsp input transform");
  assert(el.querySelector("pre") !== null, "pre created via nbsp");
  el.remove();
}

// No transform for normal text
{
  const el = makeContentEl();
  assert(!simulateInputTransform(el, "hello "), "no input transform for normal text");
  el.remove();
}

// Unwrapped text node (no <p> wrapper — common in contentEditable)
{
  const el = makeContentEl();
  const textNode = document.createTextNode("## ");
  el.appendChild(textNode);

  const range = document.createRange();
  range.setStart(textNode, 3);
  range.collapse(true);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);

  assert(checkBlockInputTransform(el), "unwrapped text node triggers transform");
  assert(el.querySelector("h2") !== null, "h2 created from unwrapped text");
  el.remove();
}

// Re-level heading: "### " at start of H1 → H3
{
  const el = makeContentEl();
  const h1 = document.createElement("h1");
  h1.textContent = "### hello";
  el.appendChild(h1);
  const range = document.createRange();
  range.setStart(h1.firstChild!, 4);
  range.collapse(true);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  assert(checkBlockInputTransform(el), "heading re-level triggers");
  const h3 = el.querySelector("h3");
  assert(h3 !== null, "h3 created from h1");
  assertEqual(h3!.textContent, "hello", "h3 preserves content");
  el.remove();
}

// Re-level heading: "## " with no content
{
  const el = makeContentEl();
  const h1 = document.createElement("h1");
  h1.textContent = "## ";
  el.appendChild(h1);
  const range = document.createRange();
  range.setStart(h1.firstChild!, 3);
  range.collapse(true);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  assert(checkBlockInputTransform(el), "heading re-level empty triggers");
  const h2 = el.querySelector("h2");
  assert(h2 !== null, "h2 created from h1");
  assertEqual(h2!.innerHTML, "<br>", "h2 empty with br");
  el.remove();
}

// No transform inside heading without marker
{
  const el = makeContentEl();
  const h2 = document.createElement("h2");
  h2.textContent = "just text";
  el.appendChild(h2);
  const range = document.createRange();
  range.setStart(h2.firstChild!, 9);
  range.collapse(true);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  assert(!checkBlockInputTransform(el), "no transform for plain heading text");
  el.remove();
}

mock.restore();
cleanup();
console.log("All transforms tests passed");
