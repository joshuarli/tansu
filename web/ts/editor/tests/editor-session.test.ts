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

  it("rejects editor, extension, task, table, paste, and resize changes while read-only", () => {
    const source = "- [ ] task\n\n| A | B |\n| --- | --- |\n| x | y |\n\n![[photo]]";
    const { container, editor, view } = mountEditor(source, {
      extensions: [{ kind: "wiki-images", resolveUrl: () => "/z-images/photo" }],
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
