import { syntaxTree } from "@codemirror/language";
import type { EditorState, Extension, Range } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { deriveFromSyntaxTree } from "./syntax-tree-cache.js";
import { frontmatterEndOffset } from "./frontmatter.js";
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

type SidenoteScan = {
  definitions: ReadonlyMap<string, NoteDefinition>;
  references: readonly NoteReference[];
  firstReference: ReadonlyMap<string, NoteReference>;
  markerNumbers: ReadonlyMap<string, string>;
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

const scanSidenotes = deriveFromSyntaxTree((state, tree): SidenoteScan => {
  const frontmatterTo = frontmatterEndOffset(state.doc);
  const codeRanges: Array<{ from: number; to: number }> = [];
  tree.iterate({
    enter(node) {
      if (node.name === "FencedCode" || node.name === "IndentedCode") {
        codeRanges.push({ from: node.from, to: node.to });
      }
    },
  });

  const isCode = (position: number): boolean => {
    let low = 0;
    let high = codeRanges.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      const range = codeRanges[middle];
      if (range === undefined) break;
      if (position < range.from) high = middle;
      else if (position >= range.to) low = middle + 1;
      else return true;
    }
    return false;
  };
  const definitions = new Map<string, NoteDefinition>();
  const duplicateDefinitions = new Set<string>();
  const definitionLines = new Set<number>();
  for (let number = 1; number <= state.doc.lines; number++) {
    const line = state.doc.line(number);
    if (line.from < frontmatterTo || isCode(line.from)) continue;
    const match = definitionPattern.exec(line.text);
    if (match?.[1] === undefined) continue;
    const label = match[1].toLowerCase();
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
      if (match?.[1] === undefined) return;
      const label = match[1].toLowerCase();
      if (!definitions.has(label)) return;
      references.push({ label, from: node.from, to: node.to, lineFrom: line.from });
    },
  });

  const firstReference = new Map<string, NoteReference>();
  for (const reference of references) {
    if (!firstReference.has(reference.label)) firstReference.set(reference.label, reference);
  }
  const markerNumbers = new Map([...firstReference.keys()].map((label, index) => [label, superscript(index + 1)]));
  return { definitions, references, firstReference, markerNumbers };
});

function buildSidenoteLayout(state: EditorState): SidenoteLayout {
  const readOnly = state.facet(readOnlyFacet);
  const { definitions, references, firstReference, markerNumbers } = scanSidenotes(state);
  const visibleLabels = [...firstReference.keys()];
  const activeLine = state.doc.lineAt(state.selection.main.head).from;
  const ranges: Range<Decoration>[] = [];
  const anchorLines = new Set<number>();

  for (const label of visibleLabels) {
    const definition = definitions.get(label);
    if (definition === undefined) continue;
    const line = state.doc.lineAt(definition.lineFrom);
    if (readOnly || activeLine !== line.from) {
      ranges.push(Decoration.replace({}).range(line.from, line.to));
    }
  }

  for (const reference of references) {
    const definition = definitions.get(reference.label);
    const marker = markerNumbers.get(reference.label);
    if (definition === undefined || marker === undefined) continue;
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
      if (update.docChanged || update.selectionSet ||
        syntaxTree(update.startState) !== syntaxTree(update.state) ||
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
