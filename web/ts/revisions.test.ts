import { setupDOM, assertEqual, assert, mockFetch } from "./test-helper.ts";
const cleanup = setupDOM();
const mock = mockFetch();

mock.on("GET", /\/api\/revisions\?/, [1000, 2000, 3000]);
mock.on("GET", /\/api\/revision\?/, { content: "# Old version" });
mock.on("POST", "/api/restore", { mtime: 5000 });

const { toggleRevisions, hideRevisions, isRevisionsOpen } = await import("./revisions.ts");
const { on, clearAll } = await import("./events.ts");

on("revision:restore", () => {});

// Create a host element to render revisions into
const host = document.createElement("div");
host.className = "revisions-container";
document.body.appendChild(host);

let hideCalled = false;
function makeOpts(path: string) {
  return {
    path,
    host,
    getCurrentContent: () => "current content",
    onHide: () => {
      hideCalled = true;
    },
  };
}

// Show revisions
toggleRevisions(makeOpts("test.md"));
await new Promise((r) => setTimeout(r, 200));

// Header
const header = host.querySelector(".revisions-header");
assert(header !== null, "header exists");
assert(header!.textContent!.includes("Revisions"), "header text");

// Revision items
const items = host.querySelectorAll(".revision-item");
assertEqual(items.length, 3, "three revision items");

// Each item has a restore button
const restoreBtn = items[0]!.querySelector(".restore-btn");
assert(restoreBtn !== null, "restore button exists");
assertEqual(restoreBtn!.textContent, "Restore", "restore button text");

// Hide revisions
hideCalled = false;
hideRevisions();
assert(!isRevisionsOpen(), "panel closed");
assert(hideCalled, "onHide callback called");
assertEqual(host.innerHTML, "", "host cleared");

// Toggle: show then toggle again hides
toggleRevisions(makeOpts("test.md"));
await new Promise((r) => setTimeout(r, 200));
assert(isRevisionsOpen(), "panel shown again");
hideCalled = false;
toggleRevisions(makeOpts("test.md"));
assert(!isRevisionsOpen(), "toggle hides");
assert(hideCalled, "onHide called on toggle-off");

// Toggle different path shows new panel
toggleRevisions(makeOpts("a.md"));
await new Promise((r) => setTimeout(r, 200));
assert(isRevisionsOpen(), "new path panel shown");
hideRevisions();

host.remove();
mock.restore();
clearAll();
cleanup();
console.log("All revisions tests passed");
