import { deriveFromSyntaxTree } from "./syntax-tree-cache.js";
import { frontmatterEndOffset } from "./frontmatter.js";

export type FindMatch = {
  from: number;
  to: number;
};

export type OutlineHeading = {
  level: number;
  line: number;
  text: string;
  from: number;
  to: number;
};

export type Outline = {
  headings: readonly OutlineHeading[];
  complete: boolean;
};

export function findLiteral(source: string, query: string): FindMatch[] {
  if (query === "") return [];
  const caseSensitive = query !== query.toLowerCase();
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  const expression = new RegExp(escaped, caseSensitive ? "gu" : "giu");
  const matches: FindMatch[] = [];
  for (const match of source.matchAll(expression)) {
    if (match.index === undefined) continue;
    matches.push({ from: match.index, to: match.index + match[0].length });
  }
  return matches;
}

export const outlineFromSyntaxTree = deriveFromSyntaxTree((state, tree): Outline => {
  const frontmatterEnd = frontmatterEndOffset(state.doc);
  const headings: OutlineHeading[] = [];
  tree.iterate({
    enter(node) {
      const heading = node.name.match(/^(?:ATX|Setext)Heading([1-6])$/);
      if (heading === null || node.from < frontmatterEnd) return;
      const raw = state.sliceDoc(node.from, node.to).split("\n", 1)[0] ?? "";
      const text = raw.replace(/^ {0,3}#{1,6}[ \t]+/, "").trim();
      headings.push({
        level: Number(heading[1]),
        line: state.doc.lineAt(node.from).number,
        text,
        from: node.from,
        to: node.to,
      });
    },
  });
  return { headings, complete: tree.length >= state.doc.length };
});
