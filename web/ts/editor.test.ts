import { setupDOM, assertEqual, assert, assertContains, mockFetch } from "./test-helper.ts";
const cleanup = setupDOM();
const mock = mockFetch();

mock.on("GET", "/api/note", { content: "# Test", mtime: 1000 });
mock.on("PUT", "/api/note", { mtime: 2000 });
mock.on("PUT", "/api/state", {});
mock.on("GET", "/api/state", { tabs: [], active: -1 });
mock.on("GET", "/api/backlinks", []);
mock.on("GET", "/api/settings", {
  weight_title: 10,
  weight_headings: 5,
  weight_tags: 2,
  weight_content: 1,
  fuzzy_distance: 1,
  result_limit: 20,
  show_score_breakdown: true,
  excluded_folders: [],
});
mock.on("GET", "/api/notes", []);
mock.on("GET", "/api/revisions", []);

const { initEditor, showEditor, hideEditor, getCurrentContent } = await import("./editor.ts");

initEditor();

// showEditor renders content
showEditor("test.md", "# Hello\n\nWorld");
await new Promise((r) => setTimeout(r, 50));

const contentEl = document.querySelector(".editor-content") as HTMLElement;
assert(contentEl !== null, "editor content element created");
assertContains(contentEl.innerHTML, "<h1>Hello</h1>", "heading rendered");
assertContains(contentEl.innerHTML, "<p>World</p>", "paragraph rendered");

// contentEditable is set
assertEqual(contentEl.contentEditable, "true", "contentEditable set");

// Source mode textarea exists (hidden)
const sourceEl = document.querySelector(".editor-source") as HTMLTextAreaElement;
assert(sourceEl !== null, "source textarea exists");
assertEqual(sourceEl.style.display, "none", "source hidden");

// Toolbar exists with buttons
const toolbar = document.querySelector(".editor-toolbar");
assert(toolbar !== null, "toolbar exists");
const buttons = toolbar!.querySelectorAll("button");
assert(buttons.length >= 2, "toolbar has buttons");

// getCurrentContent returns serialized markdown
const content = getCurrentContent();
assertContains(content, "Hello", "getCurrentContent has heading");

// hideEditor removes the editor
hideEditor();
assertEqual(document.querySelector(".editor-content"), null, "editor removed");
assertEqual(document.querySelector(".editor-source"), null, "source removed");

// After hide, getCurrentContent returns empty
assertEqual(getCurrentContent(), "", "empty after hide");

// showEditor again with different content
showEditor("other.md", "**bold text**");
await new Promise((r) => setTimeout(r, 50));
const content2 = document.querySelector(".editor-content");
assert(content2 !== null, "editor recreated");
assertContains(content2!.innerHTML, "<strong>bold text</strong>", "bold rendered");

// Empty state handling
hideEditor();
const emptyState = document.getElementById("empty-state");
assertEqual(emptyState!.style.display, "flex", "empty state shown");

mock.restore();
cleanup();
console.log("All editor tests passed");
