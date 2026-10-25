import { markdown } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { Tree } from "@lezer/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import { outlineFromSyntaxTree } from "../source-navigation.js";
import { tufteNotes } from "../tufte-notes.js";

const UPDATES = 200;

const views: EditorView[] = [];

function structuredNote(headings: number, footnotes: number): string {
  const parts: string[] = [];
  for (let index = 0; index < headings; index++) {
    parts.push(`## Heading ${index}\n\nBody paragraph ${index} with prose and a note.[^n${index % footnotes}]\n`);
  }
  for (let index = 0; index < footnotes; index++) parts.push(`[^n${index}]: Footnote text ${index}\n`);
  return parts.join("\n");
}

function mountView(doc: string): EditorView {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({ state: EditorState.create({ doc, extensions: [markdown(), tufteNotes()] }), parent });
  ensureSyntaxTree(view.state, view.state.doc.length, 5000);
  views.push(view);
  return view;
}

const metadataModules = ["tufte-notes.ts", "source-navigation.ts", "syntax-tree-cache.ts"];

function countMetadataWork(view: EditorView, run: () => void): { treeWalks: number; lineLookups: number } {
  const work = { treeWalks: 0, lineLookups: 0 };
  const countIfFromMetadata = (counter: keyof typeof work): void => {
    const stack = new Error("count metadata work").stack ?? "";
    if (metadataModules.some((module) => stack.includes(module))) work[counter]++;
  };
  const iterate = Tree.prototype.iterate;
  vi.spyOn(Tree.prototype, "iterate").mockImplementation(function (this: Tree, ...args: Parameters<Tree["iterate"]>) {
    countIfFromMetadata("treeWalks");
    return iterate.apply(this, args);
  });
  const docPrototype = Object.getPrototypeOf(view.state.doc) as { line(number: number): unknown };
  const line = docPrototype.line;
  vi.spyOn(docPrototype, "line").mockImplementation(function (this: unknown, number: number) {
    countIfFromMetadata("lineLookups");
    return line.call(this, number);
  });
  run();
  return work;
}

describe("editor layout metadata caching", () => {
  afterEach(() => {
    for (const view of views.splice(0)) {
      view.destroy();
      view.dom.remove();
    }
    vi.restoreAllMocks();
  });

  it("reuses sidenote and outline metadata across selection and viewport updates", () => {
    const source = structuredNote(60, 20);
    const view = mountView(source);
    view.dispatch({ selection: { anchor: 1 } });
    const outline = outlineFromSyntaxTree(view.state);

    const counts = countMetadataWork(view, () => {
      for (let step = 0; step < UPDATES; step++) {
        view.dispatch({ selection: { anchor: (step * 37) % source.length } });
        view.dispatch({ effects: EditorView.scrollIntoView((step * 91) % source.length) });
        expect(outlineFromSyntaxTree(view.state)).toBe(outline);
      }
    });

    expect(counts).toStrictEqual({ treeWalks: 0, lineLookups: 0 });
    expect(view.dom.querySelectorAll(".tansu-sidenote-marker").length).toBeGreaterThan(0);
    expect(outline.headings).toHaveLength(60);
  });

  it("rebuilds metadata after the document changes", () => {
    const view = mountView("# One\n\ntext[^a]\n\n[^a]: note\n");
    expect(outlineFromSyntaxTree(view.state).headings.map((heading) => heading.text)).toStrictEqual(["One"]);
    expect(view.dom.classList.contains("tansu-has-sidenotes")).toBeTruthy();

    view.dispatch({ changes: { from: 0, insert: "# Zero\n\n" } });
    ensureSyntaxTree(view.state, view.state.doc.length, 5000);

    expect(outlineFromSyntaxTree(view.state).headings.map((heading) => heading.text)).toStrictEqual(["Zero", "One"]);
    expect(view.dom.querySelectorAll(".tansu-sidenote-marker")).toHaveLength(1);

    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "plain\n" } });

    expect(outlineFromSyntaxTree(view.state).headings).toStrictEqual([]);
    expect(view.dom.classList.contains("tansu-has-sidenotes")).toBeFalsy();
  });
});
