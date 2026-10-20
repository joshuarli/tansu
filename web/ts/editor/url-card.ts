import { syntaxTree } from "@codemirror/language";
import type { EditorState, Extension, Range } from "@codemirror/state";
import { Decoration, ViewPlugin, WidgetType, type DecorationSet, type EditorView, type ViewUpdate } from "@codemirror/view";
import { frontmatterRange } from "./frontmatter.js";
import { readOnlyFacet } from "./vendor/atomic/read-only.js";

const LONE_URL = /^(https?:\/\/\S+)$/i;

export type UrlCardOptions = {
  onOpen?: (url: string) => void;
};

class UrlCardWidget extends WidgetType {
  constructor(
    private readonly url: string,
    private readonly host: string,
    private readonly onOpen: ((url: string) => void) | undefined,
    private readonly readOnly: boolean,
  ) {
    super();
  }

  override eq(other: UrlCardWidget): boolean {
    return this.url === other.url && this.readOnly === other.readOnly;
  }

  override toDOM(): HTMLElement {
    const card = document.createElement("span");
    card.className = "tansu-url-card";
    const host = document.createElement("span");
    host.className = "tansu-url-card-host";
    host.textContent = this.host;
    const address = document.createElement("span");
    address.className = "tansu-url-card-url";
    address.textContent = this.url;
    card.append(host, address);
    card.addEventListener("click", (event) => {
      if (this.onOpen === undefined || !(this.readOnly || event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      this.onOpen(this.url);
    });
    return card;
  }
}

export function loneUrlHost(lineText: string): { url: string; host: string } | null {
  const match = LONE_URL.exec(lineText.trim());
  if (match === null) return null;
  try {
    const parsed = new URL(match[1]!);
    return parsed.host === "" ? null : { url: match[1]!, host: parsed.host };
  } catch {
    return null;
  }
}

function insideCodeOrFrontmatter(state: EditorState, position: number): boolean {
  const frontmatter = frontmatterRange(state);
  if (frontmatter !== null && position <= frontmatter.foldTo) return true;
  for (let node: { name: string; parent: unknown } | null = syntaxTree(state).resolveInner(position, 1); node !== null;
    node = node.parent as typeof node) {
    if (node.name === "FencedCode" || node.name === "CodeBlock") return true;
  }
  return false;
}

function cardDecorations(view: EditorView, options: UrlCardOptions): DecorationSet {
  const state = view.state;
  const readOnly = state.facet(readOnlyFacet);
  const ranges: Range<Decoration>[] = [];
  let lastLine = 0;
  for (const { from, to } of view.visibleRanges) {
    for (let position = from; position <= to;) {
      const line = state.doc.lineAt(position);
      position = line.to + 1;
      if (line.number <= lastLine) continue;
      lastLine = line.number;
      const lone = loneUrlHost(line.text);
      if (lone === null || line.text !== line.text.trim()) continue;
      if (!readOnly && state.selection.ranges.some((range) => range.from <= line.to && range.to >= line.from)) continue;
      if (insideCodeOrFrontmatter(state, line.from)) continue;
      ranges.push(
        Decoration.replace({ widget: new UrlCardWidget(lone.url, lone.host, options.onOpen, readOnly) })
          .range(line.from, line.to),
      );
    }
  }
  return Decoration.set(ranges, true);
}

export function urlCards(options: UrlCardOptions = {}): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = cardDecorations(view, options);
      }

      update(update: ViewUpdate): void {
        if (update.docChanged || update.selectionSet || update.viewportChanged) {
          this.decorations = cardDecorations(update.view, options);
        }
      }
    },
    { decorations: (plugin) => plugin.decorations },
  );
}
