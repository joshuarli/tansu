import { createSignal } from "solid-js";

import { renderComponent } from "./component-test-helper.tsx";
import type { EditorInstance } from "./editor.ts";
import { NoteEditor } from "./features/editor/note-editor.tsx";
import type { Tab } from "./tab-state.ts";
import { mockFetch, setupDOM } from "./test-helper.ts";

describe("NoteEditor", () => {
  let cleanup: () => void;
  let mock: ReturnType<typeof mockFetch>;

  beforeEach(() => {
    cleanup = setupDOM();
    mock = mockFetch();
    mock.on("GET", "/api/backlinks", []);
  });

  afterEach(() => {
    mock.restore();
    cleanup();
  });

  it("renders empty state before editor startup", () => {
    let editor: EditorInstance | null = null;
    const [activeTab] = createSignal<Tab | null>(null);
    const harness = renderComponent(() => (
      <NoteEditor
        enabled={() => false}
        activeTab={activeTab}
        onEditorChange={(next) => (editor = next)}
      />
    ));

    expect(harness.container.querySelector("#editor-area")).toBeTruthy();
    expect(harness.container.querySelector("#empty-state")?.textContent).toContain("Cmd+K");
    expect(editor).toBeNull();

    harness.dispose();
  });

  it("owns editor lifetime and shows the active tab", async () => {
    let editor: EditorInstance | null = null;
    const [enabled, setEnabled] = createSignal(false);
    const [activeTab, setActiveTab] = createSignal<Tab | null>(null);
    const harness = renderComponent(() => (
      <NoteEditor
        enabled={enabled}
        activeTab={activeTab}
        onEditorChange={(next) => (editor = next)}
      />
    ));

    setEnabled(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(editor).not.toBeNull();
    expect(harness.container.querySelector("#empty-state")).toBeTruthy();

    setActiveTab({
      path: "note.md",
      title: "note",
      dirty: false,
      content: "# Hello",
      tags: ["alpha"],
      mtime: 1000,
      lastSavedMd: "# Hello",
      lastSavedTags: ["alpha"],
    });
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(harness.container.querySelector(".editor-content")?.innerHTML).toContain(
      "<h1>Hello</h1>",
    );
    expect(harness.container.querySelector(".tag-pill")?.textContent).toContain("#alpha");

    harness.dispose();
    expect(editor).toBeNull();
  });

  it("does not recreate the editor for same-note state echoes", async () => {
    const [enabled] = createSignal(true);
    const [activeTab, setActiveTab] = createSignal<Tab | null>({
      path: "note.md",
      title: "note",
      dirty: false,
      content: "# Hello",
      tags: ["alpha"],
      mtime: 1000,
      lastSavedMd: "# Hello",
      lastSavedTags: ["alpha"],
    });
    const harness = renderComponent(() => (
      <NoteEditor enabled={enabled} activeTab={activeTab} onEditorChange={() => void 0} />
    ));

    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(
      mock.requests.filter((req) => req.method === "GET" && req.url.includes("/api/backlinks")),
    ).toHaveLength(1);

    setActiveTab({
      path: "note.md",
      title: "note",
      dirty: true,
      content: "# Hello",
      tags: ["alpha"],
      mtime: 1001,
      lastSavedMd: "# Hello",
      lastSavedTags: ["alpha"],
    });
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(
      mock.requests.filter((req) => req.method === "GET" && req.url.includes("/api/backlinks")),
    ).toHaveLength(1);

    harness.dispose();
  });
});
