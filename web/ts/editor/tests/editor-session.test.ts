import { EditorView } from "@codemirror/view";
import { Transaction } from "@codemirror/state";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCodeMirrorEditor, type EditorHandle } from "../codemirror-adapter.js";

type MountedEditor = {
  container: HTMLElement;
  editor: EditorHandle;
  view: EditorView;
  dispose(): void;
};

const mounted: MountedEditor[] = [];

function mountEditor(
  source = "",
  config: Parameters<typeof createCodeMirrorEditor>[1] = {},
  noteId = "note",
  readOnly = false,
): MountedEditor & { session: ReturnType<EditorHandle["createSession"]> } {
  const container = document.createElement("div");
  document.body.append(container);
  const editor = createCodeMirrorEditor(container, config);
  const session = editor.createSession(noteId, source, { readOnly });
  editor.attachSession(session);
  const view = EditorView.findFromDOM(container.querySelector(".cm-editor")!);
  if (view === null) throw new Error("EditorView was not mounted");
  const item = {
    container,
    editor,
    session,
    view,
    dispose() {
      editor.dispose();
      container.remove();
    },
  };
  mounted.push(item);
  return item;
}

describe("CodeMirror editor sessions", () => {
  afterEach(() => {
    for (const item of mounted.splice(0)) item.dispose();
  });

  it("keeps the complete source and UTF-16 selection in one snapshot", () => {
    const source = "\uFEFF---\ntags:\n  - alpha\n---\n\n# Title\n\n";
    const { editor, view } = mountEditor(source);
    view.dispatch({ selection: { anchor: 2, head: 9 } });

    const snapshot = editor.getSnapshot();
    expect(snapshot).toMatchObject({
      source,
      revision: 0,
      selection: { anchor: 2, head: 9 },
      mode: "live",
      dirty: false,
    });
    expect(editor.getSnapshot()?.source).toBe(source);
    expect(editor.detachSession()?.noteId).toBe("note");
    expect(editor.getSnapshot()).toBeNull();
  });

  it("keeps find highlights separate from the editor selection", () => {
    const source = "# Heading\nworkspace in prose\nworkspace below";
    const { container, editor, view } = mountEditor(source);
    const originalSelection = view.state.selection.main;
    const firstMatch = source.indexOf("workspace");
    const lastMatch = source.lastIndexOf("workspace");
    const matches = [
      { from: firstMatch, to: firstMatch + 9 },
      { from: lastMatch, to: lastMatch + 9 },
    ];

    editor.setFindHighlights({ matches, selected: matches[0]! });

    expect(view.state.selection.main).toBe(originalSelection);
    expect(container.querySelectorAll(".cm-atomic-find-match")).toHaveLength(2);
    expect(container.querySelectorAll(".cm-atomic-find-match-active")).toHaveLength(1);
    expect(editor.getSnapshot()?.source).toBe(source);
  });

  it("keeps independent history when sessions attach to one view", () => {
    const { container, editor, session: first, view } = mountEditor("A", {}, "first");
    view.dispatch({ changes: { from: 1, insert: "1" }, annotations: Transaction.userEvent.of("input.type") });
    expect(editor.getSnapshot()).toMatchObject({ source: "A1", revision: 1, dirty: true });
    // oxlint-disable-next-line vitest/prefer-to-be-truthy -- Keep the exact boolean result.
    expect(editor.markSaved(first, 1)).toBe(true);

    const second = editor.createSession("second", "B");
    editor.attachSession(second);
    view.dispatch({ changes: { from: 1, insert: "2" }, annotations: Transaction.userEvent.of("input.type") });
    expect(editor.getSnapshot()?.source).toBe("B2");
    // oxlint-disable-next-line vitest/prefer-to-be-truthy -- Keep the exact boolean result.
    expect(editor.undo()).toBe(true);
    expect(editor.getSnapshot()?.source).toBe("B");

    editor.attachSession(first);
    expect(editor.getSnapshot()?.source).toBe("A1");
    // oxlint-disable-next-line vitest/prefer-to-be-truthy -- Keep the exact boolean result.
    expect(editor.undo()).toBe(true);
    expect(editor.getSnapshot()?.source).toBe("A");
    expect(container.querySelectorAll(".cm-editor")).toHaveLength(1);
  });

  it("snapshots an inactive session without attaching it", () => {
    const { editor, session: first, view } = mountEditor("A", {}, "first");
    view.dispatch({ changes: { from: 1, insert: "1" }, annotations: Transaction.userEvent.of("input.type") });
    const second = editor.createSession("second", "B");
    editor.attachSession(second);

    expect(editor.getSessionSnapshot(first)).toMatchObject({
      noteId: "first",
      source: "A1",
      revision: 1,
      dirty: true,
    });
    expect(editor.getSessionSnapshot(second)).toStrictEqual(editor.getSnapshot());
    expect(editor.getSnapshot()?.noteId).toBe("second");
  });

  it("reconfigures source mode without replacing the document or marking it dirty", () => {
    const { editor, view } = mountEditor("# A\n\n**bold**");
    const documentState = view.state.doc;
    const root = view.dom;
    editor.setMode("source");

    expect(view.state.doc).toBe(documentState);
    expect(view.dom).toBe(root);
    expect(editor.getSnapshot()).toMatchObject({ source: "# A\n\n**bold**", mode: "source", revision: 0, dirty: false });
    editor.setMode("live");
    expect(view.state.doc).toBe(documentState);
    expect(editor.getSnapshot()?.mode).toBe("live");
  });

  it("keeps frontmatter hidden and uneditable in both editor modes", () => {
    const source = "---\ntags:\n  - alpha\n---\n\n# Body\n";
    const { container, editor, view } = mountEditor(source, { noteTitle: "Note" });

    expect(container.querySelector(".tag-row")).toBeNull();
    expect(container.querySelector(".tag-frontmatter-toggle")).toBeNull();
    expect(container.querySelector(".cm-content")?.textContent).not.toContain("tags:");
    expect(editor.getSnapshot()).toMatchObject({ source, mode: "live", revision: 0, dirty: false });

    editor.revealSelection({ anchor: source.indexOf("tags:") + 2, head: source.indexOf("tags:") + 2 });
    expect(container.querySelector(".cm-content")?.textContent).not.toContain("tags:");
    expect(editor.getSnapshot()?.selection).toStrictEqual({
      anchor: source.indexOf("# Body"),
      head: source.indexOf("# Body"),
    });

    editor.setMode("source");
    expect(container.querySelector(".cm-content")?.textContent).not.toContain("tags:");
    view.dispatch({
      changes: { from: source.indexOf("tags:"), to: source.indexOf("tags:") + 4, insert: "name" },
    });
    expect(editor.getSnapshot()?.source).toBe(source);
  });

  it("adds tags through an undoable edit while preserving frontmatter and body source", async () => {
    const source = "---\nauthor: Jane\ntags: [alpha, beta]\n---\n\n# Body\n\nExact body.\n";
    const onChange = vi.fn();
    const { editor, view } = mountEditor(source, { onChange });

    await expect(editor.addTag("gamma")).resolves.toStrictEqual({ kind: "applied" });
    const edited = "---\nauthor: Jane\ntags: [alpha, beta, gamma]\n---\n\n# Body\n\nExact body.\n";
    expect(editor.getSnapshot()).toMatchObject({ source: edited, revision: 1, dirty: true });
    expect(onChange).toHaveBeenCalledWith({ noteId: "note", revision: 1, origin: "userEdit" });

    // oxlint-disable-next-line vitest/prefer-to-be-truthy -- Keep the exact boolean result.
    expect(editor.undo()).toBe(true);
    expect(editor.getSnapshot()).toMatchObject({ source, revision: 2, dirty: true });
    // oxlint-disable-next-line vitest/prefer-to-be-truthy -- Keep the exact boolean result.
    expect(editor.redo()).toBe(true);
    expect(editor.getSnapshot()).toMatchObject({ source: edited, revision: 3, dirty: true });
    expect(onChange).toHaveBeenCalledTimes(3);
    expect(view.state.doc.toString()).toBe(edited);
  });

  it("does not revise a note when the tag already exists", async () => {
    const onChange = vi.fn();
    const { editor } = mountEditor("---\ntags: [alpha]\n---\nbody\n", { onChange });

    await expect(editor.addTag("alpha")).resolves.toStrictEqual({ kind: "unchanged" });
    expect(editor.getSnapshot()).toMatchObject({ revision: 0, dirty: false });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("keeps the tag operation separate from nearby typing in history", async () => {
    const source = "Body text";
    const { editor, view } = mountEditor(source);
    view.dispatch({
      changes: { from: source.length, insert: " typed" },
      annotations: Transaction.userEvent.of("input.type"),
    });
    const typedSource = "Body text typed";

    await expect(editor.addTag("alpha")).resolves.toStrictEqual({ kind: "applied" });
    // oxlint-disable-next-line vitest/prefer-to-be-truthy -- Keep the exact boolean result.
    expect(editor.undo()).toBe(true);
    expect(editor.getSnapshot()?.source).toBe(typedSource);
    // oxlint-disable-next-line vitest/prefer-to-be-truthy -- Keep the exact boolean result.
    expect(editor.undo()).toBe(true);
    expect(editor.getSnapshot()?.source).toBe(source);
  });

  it("refuses malformed frontmatter and invalid tags without changing source", async () => {
    const malformed = "---\ntags: [alpha\n---\nbody\n";
    const malformedEditor = mountEditor(malformed).editor;
    await expect(malformedEditor.addTag("beta")).resolves.toMatchObject({ kind: "unavailable" });
    expect(malformedEditor.getSnapshot()).toMatchObject({ source: malformed, revision: 0, dirty: false });

    const source = "---\ntags: [alpha]\n---\nbody\n";
    const invalidEditor = mountEditor(source).editor;
    await expect(invalidEditor.addTag("bad\ntag")).resolves.toMatchObject({ kind: "unavailable" });
    expect(invalidEditor.getSnapshot()).toMatchObject({ source, revision: 0, dirty: false });
  });

  it("preserves a source BOM when adding to scalar tags", async () => {
    const source = "\uFEFF---\ntags: alpha\n---\nbody\n";
    const { editor } = mountEditor(source);

    await expect(editor.addTag("beta")).resolves.toStrictEqual({ kind: "applied" });
    expect(editor.getSnapshot()?.source).toBe("\uFEFF---\ntags: alpha, beta\n---\nbody\n");
  });

  it("adds to block lists and creates tags-only frontmatter when needed", async () => {
    const blockSource = "---\ntags:\n  - alpha\n  - beta\n---\nbody\n";
    const blockEditor = mountEditor(blockSource).editor;
    await expect(blockEditor.addTag("gamma")).resolves.toStrictEqual({ kind: "applied" });
    expect(blockEditor.getSnapshot()?.source).toBe("---\ntags:\n  - alpha\n  - beta\n  - gamma\n---\nbody\n");

    const bodySource = "# Title\n\nBody stays exact.\n";
    const bodyEditor = mountEditor(bodySource).editor;
    await expect(bodyEditor.addTag("alpha")).resolves.toStrictEqual({ kind: "applied" });
    expect(bodyEditor.getSnapshot()?.source).toBe("---\ntags: [alpha]\n---\n# Title\n\nBody stays exact.\n");
  });

  it("rewrites only the tags field when an inline value cannot hold a comma", async () => {
    const source = "---\nauthor: Jane\ntags: [alpha, beta]\n---\nbody\n";
    const { editor } = mountEditor(source);

    await expect(editor.addTag("gamma, delta")).resolves.toStrictEqual({ kind: "applied" });
    expect(editor.getSnapshot()?.source).toBe(
      "---\nauthor: Jane\ntags:\n  - alpha\n  - beta\n  - 'gamma, delta'\n---\nbody\n",
    );
  });

  it("refuses inline-list syntax whose permissive parser would lose existing tag boundaries", async () => {
    const source = "---\ntags: [[alpha]]\n---\nbody\n";
    const { editor } = mountEditor(source);

    await expect(editor.addTag("beta")).resolves.toMatchObject({ kind: "unavailable" });
    expect(editor.getSnapshot()).toMatchObject({ source, revision: 0, dirty: false });
  });

  it("refuses tag edits without an active writable session and keeps manual frontmatter edits blocked", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const editor = createCodeMirrorEditor(container);
    await expect(editor.addTag("alpha")).resolves.toMatchObject({ kind: "unavailable" });
    const session = editor.createSession("locked", "---\ntags: [one]\n---\nbody\n", { readOnly: true });
    editor.attachSession(session);
    await expect(editor.addTag("alpha")).resolves.toMatchObject({ kind: "unavailable" });
    editor.dispose();
    container.remove();

    const source = "---\ntags: [one]\n---\nbody\n";
    const writable = mountEditor(source);
    writable.view.dispatch({ changes: { from: source.indexOf("one"), to: source.indexOf("one") + 3, insert: "two" } });
    expect(writable.editor.getSnapshot()?.source).toBe(source);
    await expect(writable.editor.addTag("two")).resolves.toStrictEqual({ kind: "applied" });
    writable.view.dispatch({ changes: { from: source.indexOf("one"), to: source.indexOf("one") + 3, insert: "bad" } });
    expect(writable.editor.getSnapshot()?.source).toContain("tags: [one, two]");
  });

  it("does not apply a tag if its note changes while tag support loads", async () => {
    const { editor, view } = mountEditor("# Original\n");
    const pendingEdit = editor.addTag("alpha");
    view.dispatch({ changes: { from: view.state.doc.length, insert: "New text" } });
    await expect(pendingEdit).resolves.toMatchObject({ kind: "unavailable" });
    expect(editor.getSnapshot()?.source).toBe("# Original\nNew text");

    const pendingSwitch = editor.addTag("beta");
    const other = editor.createSession("other", "# Other\n");
    editor.attachSession(other);
    await expect(pendingSwitch).resolves.toMatchObject({ kind: "unavailable" });
    expect(editor.getSnapshot()?.source).toBe("# Other\n");
  });

  it("keeps the first body line out of the folded frontmatter line", () => {
    const body = "First paragraph after the metadata.";
    const source = `---\ntags:\n  - alpha\n---\n\n${body}\n`;
    const { container, editor } = mountEditor(source, { noteTitle: "Note" });
    const bodyLine = () => [...container.querySelectorAll<HTMLElement>(".cm-line")].find((line) =>
      line.textContent?.includes(body)
    );

    expect(container.querySelector(".cm-content")?.textContent).not.toContain("tags:");
    expect(bodyLine()?.querySelector(".cm-foldPlaceholder")).toBeNull();
    expect(bodyLine()?.querySelector(".cm-foldPlaceholder")).toBeNull();
    expect(editor.getSnapshot()).toMatchObject({ source, revision: 0, dirty: false });
  });

  it("rejects editor, extension, task, table, paste, and resize changes while read-only", () => {
    const source = "- [ ] task\n\n| A | B |\n| --- | --- |\n| x | y |\n\n![[photo]]";
    const { container, editor, view } = mountEditor(source, {
      resolveAssetUrl: () => "/z-images/photo",
    }, "locked", true);
    const before = editor.getSnapshot()!.source;

    view.dispatch({ changes: { from: 0, insert: "injected" } });
    container.querySelector<HTMLInputElement>(".cm-atomic-task-checkbox")?.click();
    const tableCell = container.querySelector<HTMLElement>(".cm-atomic-table-cell-source");
    if (tableCell) {
      tableCell.textContent = "changed";
      tableCell.dispatchEvent(new Event("input", { bubbles: true }));
    }
    const resize = container.querySelector<HTMLButtonElement>(".tansu-wiki-image-resize");
    if (resize) {
      resize.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true, clientX: 10 }));
      window.dispatchEvent(new MouseEvent("pointermove", { clientX: 80 }));
      window.dispatchEvent(new MouseEvent("pointerup"));
    }
    editor.revealSelection({ anchor: 0, head: 3 });
    const cut = new Event("cut", { bubbles: true, cancelable: true });
    Object.defineProperty(cut, "clipboardData", { value: { setData() {}, clearData() {} } });
    view.contentDOM.dispatchEvent(cut);
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", { value: { getData: () => "injected" } });
    view.contentDOM.dispatchEvent(paste);

    expect(editor.getSnapshot()).toMatchObject({ source: before, revision: 0, readOnly: true, dirty: false });
  });

  it("clears history on a clean external reload and refuses to replace a dirty session", () => {
    const { editor, session, view } = mountEditor("base");
    view.dispatch({ changes: { from: 4, insert: " draft" }, annotations: Transaction.userEvent.of("input.type") });
    const draftRevision = editor.getSnapshot()!.revision;
    expect(editor.reloadIfClean(session, "external")).toStrictEqual({ kind: "dirty", revision: draftRevision });
    // oxlint-disable-next-line vitest/prefer-to-be-truthy -- Keep the exact boolean result.
    expect(editor.markSaved(session, draftRevision)).toBe(true);
    expect(editor.reloadIfClean(session, "external")).toStrictEqual({ kind: "reloaded", revision: draftRevision + 1 });
    expect(editor.getSnapshot()).toMatchObject({ source: "external", dirty: false, revision: draftRevision + 1 });
    // oxlint-disable-next-line vitest/prefer-to-be-falsy -- Keep the exact boolean result.
    expect(editor.undo()).toBe(false);
  });

  it("reports only document edits and calls the current change handler", () => {
    const onChange = vi.fn();
    const { editor, view } = mountEditor("😀", { onChange });
    editor.setMode("source");
    editor.revealSelection({ anchor: 2, head: 2 });
    expect(onChange).not.toHaveBeenCalled();

    view.dispatch({
      changes: { from: 2, insert: "x" },
      selection: { anchor: 3 },
      annotations: Transaction.userEvent.of("input.type"),
    });
    expect(onChange).toHaveBeenCalledWith({ noteId: "note", revision: 1, origin: "userEdit" });
    expect(editor.getSnapshot()?.selection).toStrictEqual({ anchor: 3, head: 3 });
  });

  it("keeps offscreen Markdown decorations through plain-text edits and rebuilds on syntax changes", () => {
    const source = "# Heading\n\nplain text\n\n**bold**";
    const { container, view } = mountEditor(source);
    const headingLine = container.querySelector(".cm-line.cm-atomic-h1");
    expect(headingLine).not.toBeNull();
    expect(container.querySelectorAll(".cm-line.cm-atomic-paragraph-gap")).toHaveLength(1);
    expect(container.querySelectorAll(".cm-atomic-strong")).toHaveLength(1);

    view.dispatch({
      changes: { from: source.indexOf("plain") + 2, insert: "word" },
      selection: { anchor: source.indexOf("plain") + 6 },
      annotations: Transaction.userEvent.of("input.type"),
    });

    expect(container.querySelector(".cm-line.cm-atomic-h1")).toBe(headingLine);
    expect(container.querySelectorAll(".cm-line.cm-atomic-paragraph-gap")).toHaveLength(1);
    expect(container.querySelectorAll(".cm-atomic-strong")).toHaveLength(1);
    expect(view.state.doc.toString()).toBe("# Heading\n\nplwordain text\n\n**bold**");

    view.dispatch({
      changes: { from: source.indexOf("plain") + 6, insert: " " },
      selection: { anchor: source.indexOf("plain") + 7 },
      annotations: Transaction.userEvent.of("input.type"),
    });

    expect(container.querySelector(".cm-line.cm-atomic-h1")).toBe(headingLine);
    expect(container.querySelectorAll(".cm-atomic-strong")).toHaveLength(1);
    expect(view.state.doc.toString()).toBe("# Heading\n\nplword ain text\n\n**bold**");

    const plainLineEnd = view.state.doc.toString().lastIndexOf("\n\n");
    view.dispatch({
      changes: { from: plainLineEnd, insert: " **new**" },
      selection: { anchor: plainLineEnd + 8 },
      annotations: Transaction.userEvent.of("input.type"),
    });

    expect(container.querySelectorAll(".cm-atomic-strong")).toHaveLength(2);
  });

  it("maps callout decorations across body text edits", () => {
    const source = "> [!note] Existing title\n> Existing body\n\nplain paragraph";
    const { container, view } = mountEditor(source);
    const title = container.querySelector<HTMLElement>(".tansu-callout-title");
    expect(title?.textContent).toBe("📝");
    expect(container.querySelector(".cm-line.tansu-callout")?.textContent).toBe("📝 Existing title");
    expect(container.querySelector(".cm-line.tansu-callout-body")).not.toBeNull();

    view.dispatch({
      changes: { from: source.indexOf("Existing body"), insert: "Longer " },
      selection: { anchor: source.indexOf("Existing body") + 7 },
      annotations: Transaction.userEvent.of("input.type"),
    });

    expect(container.querySelector(".tansu-callout-title")?.textContent).toBe("📝");
    expect(container.querySelector(".cm-line.tansu-callout")?.textContent).toBe("📝 Existing title");
    expect(container.querySelector(".cm-line.tansu-callout-body")).not.toBeNull();
  });

  it("routes rich HTML through a sanitizer and leaves plain text to CodeMirror", () => {
    const { editor, view } = mountEditor("start end");
    editor.revealSelection({ anchor: 6, head: 6 });
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", {
      value: {
        getData: (type: string) => type === "text/html"
          ? '<p onclick="bad()">safe <a href="javascript:alert(1)">link</a></p>'
          : "plain",
      },
    });
    view.contentDOM.dispatchEvent(paste);
    expect(editor.getSnapshot()?.source).toBe("start safe linkend");
  });

  it("preserves empty lines in multiline plain-text paste", () => {
    const { editor, view } = mountEditor("start end");
    editor.revealSelection({ anchor: 6, head: 6 });
    const paste = new Event("paste", { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(paste, "clipboardData", {
      value: { getData: (type: string) => type === "text/plain" ? "first\n\nthird" : "" },
    });
    view.contentDOM.dispatchEvent(paste);

    expect(editor.getSnapshot()?.source).toBe("start first\n\nthirdend");
  });

  it("toggles a task checkbox as one source edit", () => {
    const { container, editor } = mountEditor("- [ ] task");
    const task = container.querySelector<HTMLInputElement>(".cm-atomic-task-checkbox");
    if (task === null) throw new Error("task checkbox was not rendered");

    task.click();

    expect(editor.getSnapshot()).toMatchObject({ source: "- [x] task", revision: 1, dirty: true });
  });

  it("copies and cuts the selected authored Markdown source", () => {
    const { editor, view } = mountEditor("before **bold** after");
    const written = new Map<string, string>();
    const clipboardData = {
      getData: () => "",
      setData: (type: string, value: string) => written.set(type, value),
      clearData: () => written.clear(),
    };
    const copy = new Event("copy", { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(copy, "clipboardData", { value: clipboardData });
    editor.revealSelection({ anchor: 7, head: 15 });
    expect(editor.getSnapshot()?.selection).toStrictEqual({ anchor: 7, head: 15 });
    view.contentDOM.dispatchEvent(copy);

    expect(written.get("text/plain")).toBe("**bold**");
    editor.revealSelection({ anchor: 7, head: 15 });
    const cut = new Event("cut", { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(cut, "clipboardData", { value: clipboardData });
    view.contentDOM.dispatchEvent(cut);

    expect(editor.getSnapshot()?.source).toBe("before  after");
    expect(editor.getSnapshot()?.revision).toBe(1);
  });

  it("pastes plain text without converting it to Markdown", () => {
    const { editor, view } = mountEditor("start end");
    editor.revealSelection({ anchor: 6, head: 6 });
    const paste = new Event("paste", { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(paste, "clipboardData", {
      value: { getData: (type: string) => type === "text/plain" ? "**literal**" : "" },
    });
    view.contentDOM.dispatchEvent(paste);

    expect(editor.getSnapshot()?.source).toBe("start **literal**end");
  });
});
