import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import type { EditorState, Text } from "@codemirror/state";
import type { Tree } from "@lezer/common";

const parseBudgetMs = 200;

export function fullSyntaxTree(state: EditorState): Tree {
  return ensureSyntaxTree(state, state.doc.length, parseBudgetMs) ?? syntaxTree(state);
}

export function deriveFromSyntaxTree<T>(derive: (state: EditorState, tree: Tree) => T): (state: EditorState) => T {
  const cache = new WeakMap<Tree, { doc: Text; value: T }>();
  return (state) => {
    const tree = fullSyntaxTree(state);
    const cached = cache.get(tree);
    if (cached !== undefined && cached.doc === state.doc) return cached.value;
    const value = derive(state, tree);
    cache.set(tree, { doc: state.doc, value });
    return value;
  };
}
