import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { createCodeMirrorEditor } from "../codemirror-adapter.js";
import { moveBlock } from "../block-drag.js";
import { undo } from "@codemirror/commands";

const disposers: (() => void)[] = [];

function mounted(source: string, readOnly = false) {
  const container = document.createElement("div");
  document.body.append(container);
  const editor = createCodeMirrorEditor(container, { readOnly });
  const session = editor.createSession("note", source, { readOnly });
  editor.attachSession(session);
  const view = EditorView.findFromDOM(container.querySelector(".cm-editor")!)!;
  disposers.push(() => {
    editor.dispose();
    container.remove();
  });
  return { container, editor, view, session };
}

function type(view: EditorView, text: string): void {
  for (const character of text) {
    const head = view.state.selection.main.head;
    view.dispatch({
      changes: { from: head, insert: character },
      selection: { anchor: head + 1 },
      userEvent: "input.type",
    });
  }
}

function press(view: EditorView, key: string): void {
  view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
}

afterEach(() => {
  while (disposers.length > 0) disposers.pop()!();
});

describe("block reorder", () => {
  it("moves a paragraph down past a heading in one undoable transaction", () => {
    const { view, editor, session } = mounted("alpha\n\n# Title\n\nbeta\n");
    expect(moveBlock(view, 0, 2)).toBe(true);
    expect(editor.getSessionSnapshot(session).source).toBe("# Title\n\nalpha\n\nbeta\n");
    undo(view);
    expect(editor.getSessionSnapshot(session).source).toBe("alpha\n\n# Title\n\nbeta\n");
  });

  it("moves the last block to the top and a block to the end", () => {
    const { view, editor, session } = mounted("one\n\ntwo\n\nthree");
    expect(moveBlock(view, 2, 0)).toBe(true);
    expect(editor.getSessionSnapshot(session).source).toBe("three\n\none\n\ntwo");
    expect(moveBlock(view, 0, 3)).toBe(true);
    expect(editor.getSessionSnapshot(session).source).toBe("one\n\ntwo\n\nthree");
  });

  it("reorders list items and code blocks as units", () => {
    const { view, editor, session } = mounted("- a\n- b\n  - nested\n- c\n\n```ts\nx\n```\n");
    expect(moveBlock(view, 1, 3)).toBe(true);
    expect(editor.getSessionSnapshot(session).source).toBe("- a\n- c\n- b\n  - nested\n\n```ts\nx\n```\n");
    expect(moveBlock(view, 3, 0)).toBe(true);
    expect(editor.getSessionSnapshot(session).source.startsWith("```ts\nx\n```\n\n- a")).toBe(true);
  });

  it("leaves frontmatter in place and ignores a drop onto the block's own edges", () => {
    const source = "---\ntags: [a]\n---\n\none\n\ntwo\n";
    const { view, editor, session } = mounted(source);
    expect(moveBlock(view, 0, 0)).toBe(false);
    expect(moveBlock(view, 0, 1)).toBe(false);
    expect(moveBlock(view, 1, 0)).toBe(true);
    expect(editor.getSessionSnapshot(session).source).toBe("---\ntags: [a]\n---\n\ntwo\n\none\n");
  });

  it("refuses to reorder and shows no handle in a read-only session", () => {
    const source = "one\n\ntwo\n";
    const { view, editor, session, container } = mounted(source, true);
    expect(moveBlock(view, 0, 2)).toBe(false);
    expect(editor.getSessionSnapshot(session).source).toBe(source);
    view.contentDOM.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 5, clientY: 5 }));
    expect(container.querySelector(".tansu-block-grip.is-visible")).toBeNull();
  });
});

describe("slash menu", () => {
  it("opens at line start, filters, and inserts the selected block", () => {
    const { view, container, editor, session } = mounted("");
    type(view, "/");
    expect(container.querySelectorAll(".tansu-slash-row")).toHaveLength(11);
    expect(container.querySelector(".tansu-slash-hint")?.textContent).toContain("esc");
    type(view, "head");
    expect(container.querySelectorAll(".tansu-slash-row")).toHaveLength(3);
    press(view, "ArrowDown");
    press(view, "Enter");
    expect(editor.getSessionSnapshot(session).source).toBe("## ");
    expect(view.state.selection.main.head).toBe(3);
    expect(container.querySelector(".tansu-slash-menu.is-visible")).toBeNull();
  });

  it("opens after whitespace, inserting the block on a new line", () => {
    const { view, editor, session } = mounted("note ");
    view.dispatch({ selection: { anchor: 5 } });
    type(view, "/");
    type(view, "quote");
    press(view, "Enter");
    expect(editor.getSessionSnapshot(session).source).toBe("note \n> ");
  });

  it("inserts callout, code block, table, and divider templates", () => {
    const expected: Record<string, string> = {
      callout: "> [!note]\n> ",
      "code block": "```\n\n```",
      table: "| Column | Column |\n| --- | --- |\n|  |  |",
      divider: "---\n",
    };
    for (const [query, markdown] of Object.entries(expected)) {
      const { view, editor, session } = mounted("");
      type(view, `/${query.split(" ")[0]}`);
      press(view, "Enter");
      expect(editor.getSessionSnapshot(session).source).toBe(markdown);
    }
  });

  it("separates a divider from the paragraph above so it is not a heading underline", () => {
    const { view, editor, session } = mounted("text\n");
    view.dispatch({ selection: { anchor: 5 } });
    type(view, "/divider");
    press(view, "Enter");
    expect(editor.getSessionSnapshot(session).source).toBe("text\n\n---\n");
  });

  it("escape closes the menu and leaves the typed slash", () => {
    const { view, container, editor, session } = mounted("");
    type(view, "/");
    press(view, "Escape");
    expect(container.querySelector(".tansu-slash-menu.is-visible")).toBeNull();
    expect(editor.getSessionSnapshot(session).source).toBe("/");
  });

  it("stays closed in the middle of a word, code blocks, frontmatter, and read-only sessions", () => {
    const word = mounted("a");
    word.view.dispatch({ selection: { anchor: 1 } });
    type(word.view, "/");
    expect(word.container.querySelector(".tansu-slash-menu.is-visible")).toBeNull();

    const code = mounted("```\n");
    code.view.dispatch({ selection: { anchor: 4 } });
    type(code.view, "/");
    expect(code.container.querySelector(".tansu-slash-menu.is-visible")).toBeNull();

    const frontmatter = mounted("---\ntags: [a]\n---\n");
    frontmatter.view.dispatch({ selection: { anchor: 4 } });
    type(frontmatter.view, "/");
    expect(frontmatter.container.querySelector(".tansu-slash-menu.is-visible")).toBeNull();

    const readOnly = mounted("", true);
    readOnly.view.dispatch({ changes: { from: 0, insert: "/" }, userEvent: "input.type" });
    expect(readOnly.container.querySelector(".tansu-slash-menu.is-visible")).toBeNull();
    expect(readOnly.editor.getSessionSnapshot(readOnly.session).source).toBe("");
  });
});

describe("url cards", () => {
  it("renders a lone URL line as a card off the cursor line and keeps the source", () => {
    const source = "intro\n\nhttps://example.com/path/page\n\nend";
    const { view, container, editor, session } = mounted(source);
    view.dispatch({ selection: { anchor: 0 } });
    const card = container.querySelector(".tansu-url-card");
    expect(card?.querySelector(".tansu-url-card-host")?.textContent).toBe("example.com");
    expect(card?.querySelector(".tansu-url-card-url")?.textContent).toBe("https://example.com/path/page");
    view.dispatch({ selection: { anchor: 10 } });
    expect(container.querySelector(".tansu-url-card")).toBeNull();
    expect(editor.getSessionSnapshot(session).source).toBe(source);
  });

  it("does not card a URL inside prose", () => {
    const { view, container } = mounted("see https://example.com now\n\nend");
    view.dispatch({ selection: { anchor: 30 } });
    expect(container.querySelector(".tansu-url-card")).toBeNull();
  });
});
