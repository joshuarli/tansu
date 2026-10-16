import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import type { EditorState, Extension, Range } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { readOnlyFacet } from "./vendor/atomic/read-only.js";

type NoteDefinition = {
  label: string;
  text: string;
  from: number;
  lineFrom: number;
};

type NoteReference = {
  label: string;
  from: number;
  to: number;
  lineFrom: number;
};

type SidenoteLayout = {
  decorations: DecorationSet;
  hasNotes: boolean;
};

const definitionPattern = /^\[\^([\w-]+)\]:[ \t]*(.*)$/u;
const referencePattern = /^\[\^([\w-]+)\]$/u;
const superscriptDigits: Readonly<Record<string, string>> = {
  "0": "⁰",
  "1": "¹",
  "2": "²",
  "3": "³",
  "4": "⁴",
  "5": "⁵",
  "6": "⁶",
  "7": "⁷",
  "8": "⁸",
  "9": "⁹",
};

class SidenoteReferenceWidget extends WidgetType {
  constructor(
    readonly marker: string,
    readonly definitionFrom: number,
    readonly text: string | null,
    readonly readOnly: boolean,
    readonly initiallyVisible: boolean,
  ) {
    super();
  }

  override eq(other: SidenoteReferenceWidget): boolean {
    return this.marker === other.marker && this.definitionFrom === other.definitionFrom && this.text === other.text &&
      this.readOnly === other.readOnly && this.initiallyVisible === other.initiallyVisible;
  }

  override toDOM(view: EditorView): HTMLElement {
    const reference = document.createElement("span");
    reference.className = "tansu-sidenote-reference";
    const marker = document.createElement("button");
    marker.type = "button";
    marker.className = "tansu-sidenote-marker";
    marker.textContent = this.marker;
    marker.setAttribute(
      "aria-label",
      this.readOnly
        ? `${this.initiallyVisible ? "Hide" : "Show"} note ${this.marker}`
        : `Show note source ${this.marker}`,
    );
    marker.title = this.readOnly
      ? `${this.initiallyVisible ? "Hide" : "Show"} note`
      : "Show note source";
    marker.addEventListener("pointerdown", (event) => event.preventDefault());
    reference.append(marker);

    let noteElement: HTMLElement | null = null;
    if (this.text !== null) {
      const note = document.createElement("aside");
      note.className = "tansu-sidenote-card";
      note.setAttribute("role", "note");
      note.setAttribute("aria-label", `Note ${this.marker}`);
      note.hidden = this.readOnly && !this.initiallyVisible;
      const content = document.createElement("span");
      content.className = "tansu-sidenote-text";
      content.textContent = this.text;
      note.append(content);
      reference.append(note);
      if (this.readOnly) {
        marker.setAttribute("aria-expanded", String(!note.hidden));
      }
      noteElement = note;
    }

    marker.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (this.readOnly) {
        const card = noteElement;
        if (card === null) return;
        card.hidden = !card.hidden;
        marker.setAttribute("aria-expanded", String(!card.hidden));
        marker.setAttribute("aria-label", `${card.hidden ? "Show" : "Hide"} note ${this.marker}`);
        marker.title = `${card.hidden ? "Show" : "Hide"} note`;
        return;
      }
      view.dispatch({ selection: { anchor: this.definitionFrom }, scrollIntoView: true });
      view.focus();
    });
    return reference;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

function frontmatterEnd(state: EditorState): number {
  const firstLine = state.doc.line(1);
  if (firstLine.text !== "---" && firstLine.text !== "\uFEFF---") return 0;
  for (let number = 2; number <= state.doc.lines; number++) {
    const line = state.doc.line(number);
    if (line.text === "---") return line.to + (number < state.doc.lines ? 1 : 0);
  }
  return state.doc.length;
}

function buildSidenoteLayout(state: EditorState): SidenoteLayout {
  const readOnly = state.facet(readOnlyFacet);
  const tree = ensureSyntaxTree(state, state.doc.length, 200) ?? syntaxTree(state);
  const frontmatterTo = frontmatterEnd(state);
  const codeRanges: Array<{ from: number; to: number }> = [];
  tree.iterate({
    enter(node) {
      if (node.name === "FencedCode" || node.name === "IndentedCode") {
        codeRanges.push({ from: node.from, to: node.to });
      }
    },
  });

  const isCode = (position: number): boolean => codeRanges.some((range) => range.from <= position && position < range.to);
  const definitions = new Map<string, NoteDefinition>();
  const duplicateDefinitions = new Set<string>();
  const definitionLines = new Set<number>();
  for (let number = 1; number <= state.doc.lines; number++) {
    const line = state.doc.line(number);
    if (line.from < frontmatterTo || isCode(line.from)) continue;
    const match = definitionPattern.exec(line.text);
    if (match === null) continue;
    const label = match[1]!.toLowerCase();
    definitionLines.add(line.from);
    if (definitions.has(label)) duplicateDefinitions.add(label);
    else definitions.set(label, { label, text: match[2]!, from: line.from, lineFrom: line.from });
  }
  for (const label of duplicateDefinitions) definitions.delete(label);

  const references: NoteReference[] = [];
  tree.iterate({
    enter(node) {
      if (node.name !== "Link" || node.from < frontmatterTo || isCode(node.from)) return;
      const line = state.doc.lineAt(node.from);
      if (definitionLines.has(line.from)) return;
      const match = referencePattern.exec(state.sliceDoc(node.from, node.to));
      if (match === null) return;
      const label = match[1]!.toLowerCase();
      if (!definitions.has(label)) return;
      references.push({ label, from: node.from, to: node.to, lineFrom: line.from });
    },
  });

  const activeLine = state.doc.lineAt(state.selection.main.head).from;
  const firstReference = new Map<string, NoteReference>();
  for (const reference of references) {
    if (!firstReference.has(reference.label)) firstReference.set(reference.label, reference);
  }
  const visibleLabels = [...firstReference.keys()];
  const markerNumbers = new Map(visibleLabels.map((label, index) => [label, superscript(index + 1)]));
  const ranges: Range<Decoration>[] = [];
  const anchorLines = new Set<number>();

  for (const label of visibleLabels) {
    const definition = definitions.get(label)!;
    const line = state.doc.lineAt(definition.lineFrom);
    if (readOnly || activeLine !== line.from) {
      ranges.push(Decoration.replace({}).range(line.from, line.to));
    }
  }

  for (const reference of references) {
    const definition = definitions.get(reference.label)!;
    const marker = markerNumbers.get(reference.label)!;
    const isFirst = firstReference.get(reference.label) === reference;
    const active = state.selection.ranges.some((selection) =>
      selection.from <= reference.to && selection.to >= reference.from
    );
    if (active && !readOnly) continue;
    if (!anchorLines.has(reference.lineFrom)) {
      ranges.push(Decoration.line({ attributes: { class: "tansu-sidenote-anchor" } }).range(reference.lineFrom));
      anchorLines.add(reference.lineFrom);
    }
    ranges.push(
      Decoration.replace({
        widget: new SidenoteReferenceWidget(
          marker,
          definition.from,
          readOnly ? definition.text : isFirst ? definition.text : null,
          readOnly,
          isFirst,
        ),
      }).range(reference.from + 1, reference.to - 1),
    );
  }

  return { decorations: Decoration.set(ranges, true), hasNotes: visibleLabels.length > 0 };
}

function superscript(value: number): string {
  return String(value).replace(/[0-9]/gu, (digit) => superscriptDigits[digit]!);
}

export function tufteNotes(): Extension {
  const plugin = ViewPlugin.fromClass(class {
    decorations: DecorationSet;
    hasNotes = false;

    constructor(private readonly view: EditorView) {
      this.decorations = Decoration.none;
      this.refresh();
    }

    update(update: ViewUpdate): void {
      if (update.docChanged || update.selectionSet || update.viewportChanged ||
        update.startState.facet(readOnlyFacet) !== update.state.facet(readOnlyFacet)) this.refresh();
    }

    private refresh(): void {
      const layout = buildSidenoteLayout(this.view.state);
      this.decorations = layout.decorations;
      this.hasNotes = layout.hasNotes;
    }
  }, {
    decorations: (plugin) => plugin.decorations,
  });
  return [
    plugin,
    EditorView.editorAttributes.of((view) => view.plugin(plugin)?.hasNotes
      ? { class: "tansu-has-sidenotes" }
      : null),
  ];
}
