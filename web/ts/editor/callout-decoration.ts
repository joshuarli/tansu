import { StateField, type EditorState, type Extension, type Range } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";

type CalloutOptions = {
  icons: Readonly<Record<string, string>>;
};

class CalloutTitle extends WidgetType {
  constructor(
    private readonly type: string,
    private readonly title: string,
    private readonly icon: string,
  ) {
    super();
  }

  override eq(other: CalloutTitle): boolean {
    return this.type === other.type && this.title === other.title && this.icon === other.icon;
  }

  override toDOM(): HTMLElement {
    const element = document.createElement("span");
    element.className = `tansu-callout-title tansu-callout-title-${this.type}`;
    element.textContent = this.icon === "" ? this.title : `${this.icon} ${this.title}`;
    return element;
  }
}

function calloutDecorations(state: EditorState, options: CalloutOptions): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  let fence: { marker: string; length: number } | null = null;
  let calloutType: string | null = null;

  for (let number = 1; number <= state.doc.lines; number++) {
    const line = state.doc.line(number);
    const fenceMatch = line.text.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence !== null) {
      calloutType = null;
      if (fenceMatch && fenceMatch[1]![0] === fence.marker && fenceMatch[1]!.length >= fence.length) {
        fence = null;
      }
      continue;
    }
    if (fenceMatch) {
      fence = { marker: fenceMatch[1]![0]!, length: fenceMatch[1]!.length };
      calloutType = null;
      continue;
    }

    const header = line.text.match(/^ {0,3}>[ \t]?\[!(\w+)\](?:[ \t]+(.*))?$/);
    if (header) {
      const type = header[1]!.toLowerCase();
      const title = header[2]?.trim() || titleFromType(type);
      const marker = header[0].indexOf(`[!${header[1]}]`);
      ranges.push(
        Decoration.line({ attributes: { class: `tansu-callout tansu-callout-${type}` } }).range(line.from),
        Decoration.replace({
          widget: new CalloutTitle(type, title, options.icons[type] ?? ""),
        }).range(line.from + marker, line.from + marker + header[1]!.length + 3),
      );
      calloutType = type;
      continue;
    }

    if (calloutType !== null && /^ {0,3}>/.test(line.text)) {
      ranges.push(
        Decoration.line({ attributes: { class: `tansu-callout-body tansu-callout-${calloutType}` } }).range(line.from),
      );
    } else {
      calloutType = null;
    }
  }

  return Decoration.set(ranges, true);
}

function titleFromType(type: string): string {
  return `${type[0]?.toUpperCase() ?? ""}${type.slice(1)}`;
}

export function calloutDecoration(options: CalloutOptions): Extension {
  const field = StateField.define({
    create: (state) => calloutDecorations(state, options),
    update: (decorations, transaction) =>
      transaction.docChanged ? calloutDecorations(transaction.state, options) : decorations.map(transaction.changes),
    provide: (value) => EditorView.decorations.from(value),
  });
  return field;
}
