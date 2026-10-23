import { StateField, type EditorState, type Extension, type Range, type Transaction } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";

type CalloutOptions = {
  icons: Readonly<Record<string, string>>;
};

const DEFAULT_CALLOUT_ICONS: Readonly<Record<string, string>> = {
  note: "📝",
  info: "ℹ️",
  tip: "💡",
  hint: "💡",
  important: "❗",
  warning: "⚠️",
  caution: "⚠️",
  danger: "🚨",
  bug: "🐛",
  example: "📋",
  quote: "🗨️",
  abstract: "📄",
  summary: "📄",
  todo: "✅",
  question: "❓",
  faq: "❓",
  success: "✅",
  check: "✅",
  done: "✅",
  failure: "❌",
  fail: "❌",
  missing: "❌",
};

const PLAIN_TEXT_EDIT = /^[\p{L}\p{N}\p{M} ]+$/u;

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
    element.textContent = this.icon === ""
      ? this.title
      : this.title === ""
      ? this.icon
      : `${this.icon} ${this.title}`;
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
      const title = header[2]?.trim();
      const displayTitle = title === undefined || title === "" ? titleFromType(type) : "";
      const marker = header[0].indexOf(`[!${header[1]}]`);
      ranges.push(
        Decoration.line({ attributes: { class: `tansu-callout tansu-callout-${type}` } }).range(line.from),
        Decoration.replace({
          widget: new CalloutTitle(type, displayTitle, options.icons[type] ?? DEFAULT_CALLOUT_ICONS[type] ?? ""),
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

function calloutDecorationCanMap(transaction: Transaction): boolean {
  let hasChanges = false;
  let safe = true;
  transaction.changes.iterChanges((fromA, toA, fromB, _toB, inserted) => {
    hasChanges = true;
    const removed = transaction.startState.doc.sliceString(fromA, toA);
    const added = inserted.toString();
    if (
      (removed.length !== 0 && !PLAIN_TEXT_EDIT.test(removed)) ||
      (added.length !== 0 && !PLAIN_TEXT_EDIT.test(added)) ||
      !calloutLineEditIsSafe(transaction.startState, fromA) ||
      !calloutLineEditIsSafe(transaction.state, fromB)
    ) safe = false;
  });
  return hasChanges && safe;
}

function calloutLineEditIsSafe(state: EditorState, position: number): boolean {
  const line = state.doc.lineAt(position);
  if (line.length === 0) return false;
  const prefix = state.doc.sliceString(line.from, Math.min(line.from + 8, line.to));
  if (/^ {0,3}>[ \t]?\[!/.test(prefix)) return false;
  const blockPrefix = /^ {0,4}(?:>[ \t]?|`{3,}|~{3,})/.exec(prefix);
  return blockPrefix === null || position >= line.from + blockPrefix[0].length;
}

export function calloutDecoration(options: CalloutOptions): Extension {
  const field = StateField.define({
    create: (state) => calloutDecorations(state, options),
    update: (decorations, transaction) => {
      if (!transaction.docChanged) return decorations.map(transaction.changes);
      if (calloutDecorationCanMap(transaction)) return decorations.map(transaction.changes);
      return calloutDecorations(transaction.state, options);
    },
    provide: (value) => EditorView.decorations.from(value),
  });
  return field;
}
