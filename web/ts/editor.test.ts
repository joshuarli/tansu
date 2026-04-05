import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { setupDOM, mockFetch } from "./test-helper.ts";

describe("editor", () => {
  let cleanup: () => void;
  let mock: ReturnType<typeof mockFetch>;
  let initEditor: () => void;
  let showEditor: (path: string, content: string) => void;
  let hideEditor: () => void;
  let getCurrentContent: () => string;

  beforeAll(async () => {
    cleanup = setupDOM();
    mock = mockFetch();

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

    const mod = await import("./editor.ts");
    initEditor = mod.initEditor;
    showEditor = mod.showEditor;
    hideEditor = mod.hideEditor;
    getCurrentContent = mod.getCurrentContent;

    initEditor();
  });

  afterAll(() => {
    mock.restore();
    cleanup();
  });

  test("editor rendering and content", async () => {
    // showEditor renders content
    showEditor("test.md", "# Hello\n\nWorld");
    await new Promise((r) => setTimeout(r, 50));

    const contentEl = document.querySelector(".editor-content") as HTMLElement;
    expect(contentEl !== null).toBe(true);
    expect(contentEl.innerHTML).toContain("<h1>Hello</h1>");
    expect(contentEl.innerHTML).toContain("<p>World</p>");

    // contentEditable is set
    expect(contentEl.contentEditable).toBe("true");

    // Source mode textarea exists (hidden)
    const sourceEl = document.querySelector(".editor-source") as HTMLTextAreaElement;
    expect(sourceEl !== null).toBe(true);
    expect(sourceEl.style.display).toBe("none");

    // Toolbar exists with buttons
    const toolbar = document.querySelector(".editor-toolbar");
    expect(toolbar !== null).toBe(true);
    const buttons = toolbar!.querySelectorAll("button");
    expect(buttons.length >= 2).toBe(true);

    // getCurrentContent returns serialized markdown
    const content = getCurrentContent();
    expect(content).toContain("Hello");

    // hideEditor removes the editor
    hideEditor();
    expect(document.querySelector(".editor-content")).toBe(null);
    expect(document.querySelector(".editor-source")).toBe(null);

    // After hide, getCurrentContent returns empty
    expect(getCurrentContent()).toBe("");

    // showEditor again with different content
    showEditor("other.md", "**bold text**");
    await new Promise((r) => setTimeout(r, 50));
    const content2 = document.querySelector(".editor-content");
    expect(content2 !== null).toBe(true);
    expect(content2!.innerHTML).toContain("<strong>bold text</strong>");

    // Empty state handling
    hideEditor();
    const emptyState = document.getElementById("empty-state");
    expect(emptyState!.style.display).toBe("flex");
  });

  test("source mode toggle", async () => {
    // Source mode: click Source button → textarea visible, contentEl hidden
    showEditor("toggle.md", "# Toggle");
    await new Promise((r) => setTimeout(r, 50));

    const contentElToggle = document.querySelector(".editor-content") as HTMLElement;
    const sourceElToggle = document.querySelector(".editor-source") as HTMLTextAreaElement;
    const sourceBtn = Array.from(document.querySelectorAll(".editor-toolbar button")).find(
      (b) => b.textContent === "Source",
    ) as HTMLButtonElement;
    expect(sourceBtn !== null).toBe(true);

    // Click Source button to enter source mode
    sourceBtn.click();
    expect(contentElToggle.style.display).toBe("none");
    expect(sourceElToggle.style.display !== "none").toBe(true);

    // Source mode getCurrentContent returns textarea value
    sourceElToggle.value = "# Raw markdown";
    const srcContent = getCurrentContent();
    expect(srcContent).toBe("# Raw markdown");

    // Click Source button again to return to rich text mode
    sourceBtn.click();
    expect(contentElToggle.style.display !== "none").toBe(true);
    expect(sourceElToggle.style.display).toBe("none");

    // Verify getCurrentContent in source mode reflects textarea directly
    showEditor("cm.md", "# Current");
    await new Promise((r) => setTimeout(r, 50));
    const cmSource = document.querySelector(".editor-source") as HTMLTextAreaElement;
    const cmSourceBtn = Array.from(document.querySelectorAll(".editor-toolbar button")).find(
      (b) => b.textContent === "Source",
    ) as HTMLButtonElement;
    cmSourceBtn.click();
    cmSource.value = "custom source";
    expect(getCurrentContent()).toBe("custom source");
    hideEditor();
  });
});
