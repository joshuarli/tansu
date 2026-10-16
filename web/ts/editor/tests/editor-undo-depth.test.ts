import { isolateHistory } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { createCodeMirrorEditor, type EditorHandle } from "../codemirror-adapter.js";

type MountedEditor = { editor: EditorHandle; view: EditorView; container: HTMLElement };

const mounted: MountedEditor[] = [];

function mountEditor(source: string, config: Parameters<typeof createCodeMirrorEditor>[1] = {}): MountedEditor & {
  session: ReturnType<EditorHandle["createSession"]>;
} {
  const container = document.createElement("div");
  document.body.append(container);
  const editor = createCodeMirrorEditor(container, config);
  const session = editor.createSession("note", source);
  editor.attachSession(session);
  const view = EditorView.findFromDOM(container.querySelector(".cm-editor")!);
  if (view === null) throw new Error("EditorView was not mounted");
  const item = { editor, view, container, session };
  mounted.push(item);
  return item;
}

function typeSeparateEdits(view: EditorView, count: number): void {
  for (let index = 0; index < count; index += 1) {
    view.dispatch({
      changes: { from: view.state.doc.length, insert: "x" },
      annotations: isolateHistory.of("full"),
    });
  }
}

function undoAll(editor: EditorHandle): number {
  let undone = 0;
  while (editor.undo()) undone += 1;
  return undone;
}

describe("CodeMirror undo depth", () => {
  afterEach(() => {
    for (const item of mounted.splice(0)) {
      item.editor.dispose();
      item.container.remove();
    }
  });

  it("keeps at least the configured number of undo steps and bounds the stack near it", () => {
    const { editor, view } = mountEditor("", { undoStackMax: 20 });
    typeSeparateEdits(view, 300);

    const undone = undoAll(editor);

    expect(undone).toBeGreaterThanOrEqual(20);
    expect(undone).toBeLessThanOrEqual(40);
    expect(view.state.doc).toHaveLength(300 - undone);
  });

  it("applies a live depth change to the next edits and keeps the document", () => {
    const { editor, view } = mountEditor("", { undoStackMax: 200 });
    typeSeparateEdits(view, 150);

    editor.updateConfiguration({ undoStackMax: 20 });
    expect(view.state.doc.toString()).toBe("x".repeat(150));
    typeSeparateEdits(view, 150);

    const undone = undoAll(editor);
    expect(undone).toBeLessThanOrEqual(40);
    expect(view.state.doc).toHaveLength(300 - undone);
  });

  it("raises the depth on a live change", () => {
    const { editor, view } = mountEditor("", { undoStackMax: 20 });
    editor.updateConfiguration({ undoStackMax: 200 });
    typeSeparateEdits(view, 150);

    expect(undoAll(editor)).toBe(150);
  });

  it("applies the live depth to a session that was not active during the change", () => {
    const { editor, view, session: first } = mountEditor("", { undoStackMax: 200 });
    typeSeparateEdits(view, 100);
    const second = editor.createSession("other", "");
    editor.attachSession(second);

    editor.updateConfiguration({ undoStackMax: 20 });
    editor.attachSession(first);
    typeSeparateEdits(view, 200);

    expect(undoAll(editor)).toBeLessThanOrEqual(40);
  });
});
