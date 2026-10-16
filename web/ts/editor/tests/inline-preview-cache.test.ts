import { markdown } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { Tree } from "@lezer/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inlinePreview } from "../vendor/atomic/inline-preview.js";

const UPDATES = 100;
const PARAGRAPHS = 200;

const views: EditorView[] = [];

afterEach(() => {
  for (const view of views.splice(0)) {
    view.destroy();
    view.dom.remove();
  }
  vi.restoreAllMocks();
});

function paragraphs(count: number): string {
  return Array.from({ length: count }, (_, index) => `Paragraph ${index} with *emphasis* and text.`).join("\n\n");
}

function mountView(doc: string): EditorView {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({ state: EditorState.create({ doc, extensions: [markdown(), inlinePreview()] }), parent });
  ensureSyntaxTree(view.state, view.state.doc.length, 5000);
  views.push(view);
  return view;
}

function countPreviewWork(run: () => void): { blankLineScans: number } {
  const work = { blankLineScans: 0 };
  const resolveInner = Tree.prototype.resolveInner;
  vi.spyOn(Tree.prototype, "resolveInner").mockImplementation(function (this: Tree, ...args: Parameters<Tree["resolveInner"]>) {
    if ((new Error().stack ?? "").includes("inline-preview.ts")) work.blankLineScans++;
    return resolveInner.apply(this, args);
  });
  run();
  return work;
}

describe("inline preview caching", () => {
  it("does not rescan blank lines when only the selection changes", () => {
    const source = paragraphs(PARAGRAPHS);
    const view = mountView(source);
    view.dispatch({ selection: { anchor: 1 } });

    const counts = countPreviewWork(() => {
      for (let step = 0; step < UPDATES; step++) {
        view.dispatch({ selection: { anchor: (step * 211) % source.length } });
      }
    });

    expect(counts.blankLineScans).toBe(0);
    expect(view.dom.querySelectorAll(".cm-atomic-paragraph-gap").length).toBeGreaterThan(0);
  });

  it("recomputes paragraph gaps after the document changes", () => {
    const view = mountView("one\n\ntwo\n");
    ensureSyntaxTree(view.state, view.state.doc.length, 5000);
    const gaps = () => view.dom.querySelectorAll(".cm-atomic-paragraph-gap").length;
    expect(gaps()).toBe(1);

    view.dispatch({ changes: { from: view.state.doc.length, insert: "\nthree\n" } });
    ensureSyntaxTree(view.state, view.state.doc.length, 5000);
    view.dispatch({ selection: { anchor: 0 } });

    expect(gaps()).toBe(2);
  });
});
