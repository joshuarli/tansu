import { syntaxTree } from "@codemirror/language";
import { Prec, StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, keymap, type ViewUpdate } from "@codemirror/view";
import { frontmatterRange } from "./frontmatter.js";
import { readOnlyFacet } from "./vendor/atomic/read-only.js";

export type SlashBlockId =
  | "heading-1"
  | "heading-2"
  | "heading-3"
  | "bullet-list"
  | "numbered-list"
  | "task-list"
  | "quote"
  | "callout"
  | "code-block"
  | "table"
  | "divider";

export type SlashBlock = {
  id: SlashBlockId;
  label: string;
  keywords: string;
  markdown: string;
  cursor: number;
  separatedFromParagraph: boolean;
};

export const SLASH_BLOCKS: readonly SlashBlock[] = [
  { id: "heading-1", label: "Heading 1", keywords: "h1 title", markdown: "# ", cursor: 2, separatedFromParagraph: false },
  { id: "heading-2", label: "Heading 2", keywords: "h2 subtitle", markdown: "## ", cursor: 3, separatedFromParagraph: false },
  { id: "heading-3", label: "Heading 3", keywords: "h3", markdown: "### ", cursor: 4, separatedFromParagraph: false },
  { id: "bullet-list", label: "Bullet list", keywords: "ul unordered", markdown: "- ", cursor: 2, separatedFromParagraph: false },
  { id: "numbered-list", label: "Numbered list", keywords: "ol ordered", markdown: "1. ", cursor: 3, separatedFromParagraph: false },
  { id: "task-list", label: "Task list", keywords: "todo checkbox", markdown: "- [ ] ", cursor: 6, separatedFromParagraph: false },
  { id: "quote", label: "Quote", keywords: "blockquote", markdown: "> ", cursor: 2, separatedFromParagraph: false },
  { id: "callout", label: "Callout", keywords: "note admonition", markdown: "> [!note]\n> ", cursor: 12, separatedFromParagraph: false },
  { id: "code-block", label: "Code block", keywords: "fence pre", markdown: "```\n\n```", cursor: 4, separatedFromParagraph: false },
  {
    id: "table",
    label: "Table",
    keywords: "grid",
    markdown: "| Column | Column |\n| --- | --- |\n|  |  |",
    cursor: 2,
    separatedFromParagraph: false,
  },
  { id: "divider", label: "Divider", keywords: "hr rule line", markdown: "---\n", cursor: 4, separatedFromParagraph: true },
];

export function filterSlashBlocks(query: string): SlashBlock[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [...SLASH_BLOCKS];
  return SLASH_BLOCKS.filter((block) =>
    block.label.toLowerCase().includes(needle) || block.keywords.split(" ").some((word) => word.startsWith(needle))
  );
}

export type SlashInsertion = {
  from: number;
  to: number;
  insert: string;
  cursor: number;
};

export function planSlashInsertion(state: EditorState, from: number, to: number, block: SlashBlock): SlashInsertion {
  const line = state.doc.lineAt(from);
  const atLineStart = state.sliceDoc(line.from, from).trim() === "";
  const paragraphAbove = line.number > 1 && state.doc.line(line.number - 1).text.trim() !== "";
  const prefix = !atLineStart || (block.separatedFromParagraph && paragraphAbove) ? "\n" : "";
  return { from, to, insert: prefix + block.markdown, cursor: from + prefix.length + block.cursor };
}

type SlashState = { from: number; selected: number };

const closeSlash = StateEffect.define<null>();
const moveSlash = StateEffect.define<1 | -1>();

const CODE_NODES = new Set(["FencedCode", "CodeBlock", "InlineCode", "CodeText", "CodeInfo", "CodeMark"]);

function slashAllowedAt(state: EditorState, position: number): boolean {
  if (state.facet(readOnlyFacet)) return false;
  const line = state.doc.lineAt(position);
  const prefix = state.sliceDoc(line.from, position);
  if (prefix !== "" && !/\s$/.test(prefix)) return false;
  const frontmatter = frontmatterRange(state);
  if (frontmatter !== null && position <= frontmatter.foldTo) return false;
  for (let node: { name: string; parent: unknown } | null = syntaxTree(state).resolveInner(position, 1); node !== null;
    node = node.parent as typeof node) {
    if (CODE_NODES.has(node.name)) return false;
  }
  return true;
}

function slashQuery(state: EditorState, slash: SlashState): string | null {
  const selection = state.selection.main;
  if (!selection.empty || selection.head <= slash.from || state.sliceDoc(slash.from, slash.from + 1) !== "/") return null;
  const query = state.sliceDoc(slash.from + 1, selection.head);
  return /\s|\n/.test(query) ? null : query;
}

export const slashMenuField = StateField.define<SlashState | null>({
  create: () => null,
  update(value, transaction) {
    const state = transaction.state;
    if (state.facet(readOnlyFacet) || transaction.effects.some((effect) => effect.is(closeSlash))) return null;
    let current = value;
    if (current !== null) {
      current = { ...current, from: transaction.changes.mapPos(current.from, -1) };
      const query = slashQuery(state, current);
      if (query === null) current = null;
      else if (filterSlashBlocks(query).length === 0) current = null;
      else if (transaction.docChanged) current = { ...current, selected: 0 };
    }
    if (current === null && transaction.isUserEvent("input.type") && transaction.docChanged) {
      const head = state.selection.main.head;
      if (state.selection.main.empty && head > 0 && state.sliceDoc(head - 1, head) === "/" &&
        slashAllowedAt(state, head - 1)) {
        current = { from: head - 1, selected: 0 };
      }
    }
    for (const effect of transaction.effects) {
      if (effect.is(moveSlash) && current !== null) {
        const count = filterSlashBlocks(slashQuery(state, current) ?? "").length;
        current = { ...current, selected: (current.selected + effect.value + count) % count };
      }
    }
    return current;
  },
});

function visibleBlocks(state: EditorState): { slash: SlashState; blocks: SlashBlock[] } | null {
  const slash = state.field(slashMenuField);
  if (slash === null) return null;
  const query = slashQuery(state, slash);
  return query === null ? null : { slash, blocks: filterSlashBlocks(query) };
}

export function insertSlashBlock(view: EditorView, block: SlashBlock): boolean {
  const open = visibleBlocks(view.state);
  if (open === null) return false;
  const plan = planSlashInsertion(view.state, open.slash.from, view.state.selection.main.head, block);
  view.dispatch({
    changes: { from: plan.from, to: plan.to, insert: plan.insert },
    selection: { anchor: plan.cursor },
    userEvent: "input.complete",
    scrollIntoView: true,
  });
  return true;
}

function element(tag: string, className: string, text = ""): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== "") node.textContent = text;
  return node;
}

export const SLASH_MENU_HINT = "type to filter · ↑↓ · ↵ insert · esc";

class SlashMenuView {
  private readonly menu = element("div", "tansu-slash-menu");
  private readonly list = element("div", "tansu-slash-list");

  constructor(private readonly view: EditorView) {
    this.menu.setAttribute("role", "dialog");
    this.menu.setAttribute("aria-label", "Insert block");
    this.list.setAttribute("role", "listbox");
    this.menu.append(this.list, element("div", "tansu-slash-hint", SLASH_MENU_HINT));
    this.menu.addEventListener("pointerdown", (event) => event.preventDefault());
    view.dom.append(this.menu);
    this.render(view.state);
  }

  update(update: ViewUpdate): void {
    if (update.docChanged || update.selectionSet || update.viewportChanged ||
      update.transactions.some((transaction) => transaction.effects.length > 0)) this.render(update.state);
  }

  destroy(): void {
    this.menu.remove();
  }

  private render(state: EditorState): void {
    const open = visibleBlocks(state);
    if (open === null) {
      this.menu.classList.remove("is-visible");
      this.list.replaceChildren();
      return;
    }
    this.list.replaceChildren(...open.blocks.map((block, index) => {
      const row = element("div", "tansu-slash-row");
      row.setAttribute("role", "option");
      row.dataset["block"] = block.id;
      const selected = index === open.slash.selected;
      row.setAttribute("aria-selected", String(selected));
      row.classList.toggle("is-selected", selected);
      row.append(element("span", "tansu-slash-label", block.label));
      row.addEventListener("click", () => insertSlashBlock(this.view, block));
      return row;
    }));
    this.menu.classList.add("is-visible");
    this.list.querySelector(".is-selected")?.scrollIntoView?.({ block: "nearest" });
    const anchor = open.slash.from;
    this.view.requestMeasure({
      key: this,
      read: (view) => ({
        coords: view.coordsAtPos(anchor),
        size: this.menu.getBoundingClientRect(),
      }),
      write: ({ coords, size }) => {
        if (coords === null) return;
        const below = coords.bottom + 6;
        this.menu.style.left = `${Math.max(8, Math.min(window.innerWidth - size.width - 8, coords.left))}px`;
        this.menu.style.top = `${below + size.height > window.innerHeight ? Math.max(8, coords.top - size.height - 6) : below}px`;
      },
    });
  }
}

function selectedBlock(view: EditorView): SlashBlock | null {
  const open = visibleBlocks(view.state);
  return open?.blocks[open.slash.selected] ?? null;
}

export function slashMenu(): Extension {
  return [
    slashMenuField,
    ViewPlugin.fromClass(SlashMenuView),
    Prec.highest(keymap.of([
      {
        key: "ArrowDown",
        run: (view) => view.state.field(slashMenuField) === null ? false : (view.dispatch({ effects: moveSlash.of(1) }), true),
      },
      {
        key: "ArrowUp",
        run: (view) => view.state.field(slashMenuField) === null ? false : (view.dispatch({ effects: moveSlash.of(-1) }), true),
      },
      {
        key: "Enter",
        run: (view) => {
          const block = selectedBlock(view);
          return block === null ? false : insertSlashBlock(view, block);
        },
      },
      {
        key: "Tab",
        run: (view) => {
          const block = selectedBlock(view);
          return block === null ? false : insertSlashBlock(view, block);
        },
      },
      {
        key: "Escape",
        run: (view) => view.state.field(slashMenuField) === null ? false : (view.dispatch({ effects: closeSlash.of(null) }), true),
      },
    ])),
  ];
}
