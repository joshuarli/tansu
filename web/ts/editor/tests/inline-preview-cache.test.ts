import { markdown } from "@codemirror/lang-markdown";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { Tree } from "@lezer/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inlinePreview } from "../vendor/atomic/inline-preview.js";
import { treeGrowthEffect } from "../vendor/atomic/tree-progress.js";

vi.mock(import("@codemirror/language"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, ensureSyntaxTree: vi.fn(actual.ensureSyntaxTree) };
});

const UPDATES = 100;
const PARAGRAPHS = 200;

const views: EditorView[] = [];

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

function countPreviewWork(run: () => void): { blankLineScans: number; syntaxTreeWalks: number } {
  const work = { blankLineScans: 0, syntaxTreeWalks: 0 };
  const resolveInner = Tree.prototype.resolveInner;
  vi.spyOn(Tree.prototype, "resolveInner").mockImplementation(function (this: Tree, ...args: Parameters<Tree["resolveInner"]>) {
    if ((new Error("count preview work").stack ?? "").includes("inline-preview.ts")) work.blankLineScans++;
    return resolveInner.apply(this, args);
  });
  const iterate = Tree.prototype.iterate;
  vi.spyOn(Tree.prototype, "iterate").mockImplementation(function (this: Tree, ...args: Parameters<Tree["iterate"]>) {
    work.syntaxTreeWalks++;
    return iterate.apply(this, args);
  });
  run();
  return work;
}

describe("inline preview caching", () => {
  afterEach(() => {
    for (const view of views.splice(0)) {
      view.destroy();
      view.dom.remove();
    }
    vi.restoreAllMocks();
  });

  it("reuses cached syntax work when only the selection changes", () => {
    const source = paragraphs(PARAGRAPHS);
    const view = mountView(source);
    view.dispatch({ selection: { anchor: 1 } });

    const counts = countPreviewWork(() => {
      for (let step = 0; step < UPDATES; step++) {
        view.dispatch({ selection: { anchor: (step * 211) % source.length } });
      }
    });

    expect(counts.blankLineScans).toBe(0);
    expect(counts.syntaxTreeWalks).toBe(0);
    expect(view.dom.querySelectorAll(".cm-atomic-paragraph-gap").length).toBeGreaterThan(0);
  });

  it("recalculates selection-sensitive syntax decorations from cached nodes", () => {
    const view = mountView("# Heading\n\nplain text");
    view.dom.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    view.dispatch({ selection: { anchor: 1 } });

    expect(view.dom.querySelectorAll(".cm-atomic-heading-mark")).toHaveLength(1);

    view.dispatch({ selection: { anchor: 12 } });

    expect(view.dom.querySelectorAll(".cm-atomic-heading-mark")).toHaveLength(0);
  });

  it("decorates syntax parsed after a tree-growth effect", () => {
    const source = `${Array.from({ length: 7 }, () => "plain ".repeat(100)).join("\n")}\n\n**Late emphasis**`;
    const parent = document.createElement("div");
    document.body.append(parent);
    vi.mocked(ensureSyntaxTree).mockReturnValueOnce(null);
    const view = new EditorView({
      state: EditorState.create({ doc: source, extensions: [markdown(), inlinePreview()] }),
      parent,
    });
    views.push(view);

    const initialTreeLength = syntaxTree(view.state).length;
    expect(initialTreeLength).toBeLessThan(source.length);
    expect(view.dom.querySelectorAll(".cm-atomic-strong")).toHaveLength(0);

    const grownTree = ensureSyntaxTree(view.state, view.state.doc.length, 5000);
    expect(grownTree?.length).toBeGreaterThan(initialTreeLength);
    expect(grownTree?.length).toBe(source.length);

    view.dispatch({ effects: treeGrowthEffect.of(null) });

    expect(syntaxTree(view.state)).toHaveLength(source.length);
    expect(view.dom.querySelectorAll(".cm-atomic-strong")).toHaveLength(1);
  });

  it("recomputes paragraph gaps after the document changes", () => {
    const view = mountView("one\n\ntwo\n");
    ensureSyntaxTree(view.state, view.state.doc.length, 5000);
    const gaps = () => view.dom.querySelectorAll(".cm-atomic-paragraph-gap").length;
    expect(gaps()).toBe(1);

    const counts = countPreviewWork(() => {
      view.dispatch({ changes: { from: view.state.doc.length, insert: "\nthree\n" } });
    });
    ensureSyntaxTree(view.state, view.state.doc.length, 5000);
    view.dispatch({ selection: { anchor: 0 } });

    expect(counts.syntaxTreeWalks).toBeGreaterThan(0);
    expect(gaps()).toBe(2);
  });
});
