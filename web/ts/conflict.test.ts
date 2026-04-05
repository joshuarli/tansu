import { setupDOM, assertEqual, assert, mockFetch } from "./test-helper.ts";
const cleanup = setupDOM();
const mock = mockFetch();

mock.on("PUT", "/api/note", { mtime: 2000 });
mock.on("PUT", "/api/state", {});
mock.on("GET", "/api/state", { tabs: [], active: -1 });

// Import AFTER mocks so module-level fetches see them
const { showConflictBanner, handleReloadConflict } = await import("./conflict.ts");

function makeContainer(): HTMLElement {
  const div = document.createElement("div");
  document.body.appendChild(div);
  return div;
}

// Test 1: showConflictBanner creates banner with correct elements
{
  const container = makeContainer();
  showConflictBanner(container, "notes/a.md", "disk content", 1000, () => {}, () => "mine");

  const banner = container.querySelector(".conflict-banner");
  assert(banner !== null, "banner exists");

  const span = banner!.querySelector("span");
  assert(span !== null, "message span exists");
  assert(span!.textContent!.includes("File changed externally"), "message text correct");

  const buttons = banner!.querySelectorAll("button");
  assertEqual(buttons.length, 2, "two buttons");
  assertEqual(buttons[0]!.textContent, "Keep mine", "first button is Keep mine");
  assertEqual(buttons[1]!.textContent, "Take theirs", "second button is Take theirs");
}

// Test 2: "Keep mine" removes banner and calls saveNote
{
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

  // Banner should be removed immediately
  assert(container.querySelector(".conflict-banner") === null, "banner removed after Keep mine");

  // saveNote is async; give it a tick to fire the fetch
  await new Promise((r) => setTimeout(r, 10));
}

// Test 3: "Take theirs" removes banner and calls loadContent with diskContent
{
  const container = makeContainer();
  let loadedWith = "";
  showConflictBanner(
    container,
    "notes/c.md",
    "their content",
    1500,
    (md) => { loadedWith = md; },
    () => "my content",
  );

  const banner = container.querySelector(".conflict-banner")!;
  const takeBtn = banner.querySelectorAll("button")[1]! as HTMLButtonElement;
  takeBtn.click();

  assert(container.querySelector(".conflict-banner") === null, "banner removed after Take theirs");
  assertEqual(loadedWith, "their content", "loadContent called with diskContent");
}

// Test 4: calling showConflictBanner twice replaces the previous banner
{
  const container = makeContainer();
  showConflictBanner(container, "notes/d.md", "first disk", 1000, () => {}, () => "mine");
  showConflictBanner(container, "notes/d.md", "second disk", 2000, () => {}, () => "mine");

  const banners = container.querySelectorAll(".conflict-banner");
  assertEqual(banners.length, 1, "only one banner after calling twice");
}

// Test 5: handleReloadConflict with non-conflicting changes auto-merges
// base="a\nb", ours="a\nb\nc" (ours appended), theirs="x\na\nb" (theirs prepended)
// merge3 should produce "x\na\nb\nc"
{
  const container = makeContainer();
  let loadedWith = "";
  const tab = {
    path: "notes/e.md",
    title: "e",
    content: "a\nb",       // base: what was last known
    mtime: 1000,
    dirty: true,
  };

  handleReloadConflict(
    tab,
    container,
    "notes/e.md",
    "x\na\nb",             // theirs (disk)
    2000,
    (md) => { loadedWith = md; },
    () => "a\nb\nc",       // ours (editor)
  );

  assert(container.querySelector(".conflict-banner") === null, "no banner on clean merge");
  assertEqual(loadedWith, "x\na\nb\nc", "merged content loaded");
  assertEqual(tab.mtime, 2000, "tab mtime updated after merge");
}

// Test 6: handleReloadConflict with conflicting changes shows banner
// base="a\nb", ours changed line 2 one way, theirs changed line 2 differently
{
  const container = makeContainer();
  let loadedWith = "";
  const tab = {
    path: "notes/f.md",
    title: "f",
    content: "a\nb",
    mtime: 1000,
    dirty: true,
  };

  handleReloadConflict(
    tab,
    container,
    "notes/f.md",
    "a\nY",                // theirs: changed line 2 to Y
    2000,
    (md) => { loadedWith = md; },
    () => "a\nX",          // ours: changed line 2 to X — conflict
  );

  assert(container.querySelector(".conflict-banner") !== null, "banner shown on conflict");
  assertEqual(loadedWith, "", "loadContent not called on conflict");
}

mock.restore();
cleanup();
console.log("All conflict tests passed");
