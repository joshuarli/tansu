import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { createCodeMirrorEditor } from "../codemirror-adapter.js";
import { createCalloutExtension, createWikiImageExtension, createWikiLinkExtension } from "../tansu-extensions.js";
import { findLiteral } from "../source-navigation.js";
import { resolveWikiTarget, suggestWikiTargets, type WikiNote } from "../wiki-target.js";

function mounted(source: string, config: Parameters<typeof createCodeMirrorEditor>[1] = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  const editor = createCodeMirrorEditor(container, config);
  const session = editor.createSession("current", source);
  editor.attachSession(session);
  const view = EditorView.findFromDOM(container.querySelector(".cm-editor")!);
  if (view === null) throw new Error("EditorView was not mounted");
  return {
    container,
    editor,
    view,
    dispose() {
      editor.dispose();
      container.remove();
    },
  };
}

describe("source-preserving Markdown operations", () => {
  it("opens read-only links directly", () => {
    const opened: string[] = [];
    const { container, dispose } = mounted("[article link](https://example.test/article)", {
      readOnly: true,
      onLinkOpen: (url) => opened.push(url),
    });
    try {
      const link = container.querySelector<HTMLElement>(".cm-atomic-link");
      expect(link).not.toBeNull();
      link!.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
      expect(opened).toStrictEqual(["https://example.test/article"]);
    } finally {
      dispose();
    }
  });

  it("finds literal text with smartcase and UTF-16 source offsets", () => {
    const source = "😀 café CAFÉ café";
    expect(findLiteral(source, "café")).toStrictEqual([
      { from: 3, to: 7 },
      { from: 8, to: 12 },
      { from: 13, to: 17 },
    ]);
    expect(findLiteral(source, "CAFÉ")).toStrictEqual([{ from: 8, to: 12 }]);
    expect(findLiteral("x.* x.*", ".*")).toStrictEqual([{ from: 1, to: 3 }, { from: 5, to: 7 }]);
  });

  it("builds the outline from Markdown headings outside frontmatter and code fences", () => {
    const { editor, dispose } = mounted(
      "---\n# metadata\n---\n\n```md\n# fenced\n```\n\n# Visible\n## 😀 Child\n",
    );
    try {
      expect(editor.outline()).toMatchObject({
        complete: true,
        headings: [
          { level: 1, text: "Visible" },
          { level: 2, text: "😀 Child" },
        ],
      });
    } finally {
      dispose();
    }
  });

  it("renders wiki images and callouts without changing the source", () => {
    const source = "![[photo|320]]\n> [!warning]\n> body\n\n> [!warning\n";
    const { container, editor, dispose } = mounted(source, {
      extensions: [
        createWikiImageExtension({ resolveUrl: () => "/z-images/photo" }),
        createCalloutExtension(),
      ],
    });
    try {
      expect(container.querySelector<HTMLImageElement>(".tansu-wiki-image img")?.src).toContain(
        "/z-images/photo",
      );
      expect(container.querySelectorAll(".tansu-callout-title")).toHaveLength(1);
      expect(editor.getSnapshot()?.source).toBe(source);
      expect(container.textContent).toContain("[!warning");
    } finally {
      dispose();
    }
  });

  it("resolves standard Markdown vault images through the asset resolver", () => {
    const imageUrl = "/api/v2/vaults/vault-1/assets?name=z-images%2Fphoto.webp";
    const { container, dispose } = mounted("![photo](z-images/photo.webp)\n", {
      extensions: [
        createWikiImageExtension({
          resolveUrl: (name) => name === "z-images/photo.webp" ? imageUrl : null,
        }),
      ],
    });
    try {
      expect(container.querySelector(".cm-atomic-image img")?.getAttribute("src")).toBe(imageUrl);
    } finally {
      dispose();
    }
  });

  it("resizes one wiki image with one undoable source change", () => {
    const source = "before ![[photo]] after\n";
    const { container, editor, dispose } = mounted(source, {
      extensions: [createWikiImageExtension({ resolveUrl: () => "/z-images/photo" })],
    });
    try {
      const handle = container.querySelector<HTMLButtonElement>(".tansu-wiki-image-resize")!;
      handle.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true, clientX: 100 }));
      window.dispatchEvent(new MouseEvent("pointermove", { clientX: 150 }));
      window.dispatchEvent(new MouseEvent("pointerup"));
      expect(editor.getSnapshot()?.source).toBe("before ![[photo|370]] after\n");
      // oxlint-disable-next-line vitest/prefer-to-be-truthy -- Keep the exact boolean result.
      expect(editor.undo()).toBe(true);
      expect(editor.getSnapshot()?.source).toBe(source);
    } finally {
      dispose();
    }
  });

  it("edits only the selected table cell source span", () => {
    const source = "before\n\n|A  | B|\n|---|---|\n| x  |y |\n\nafter\n";
    const { container, editor, dispose } = mounted(source);
    try {
      const cell = container.querySelector<HTMLElement>("tbody td");
      const input = cell?.querySelector<HTMLElement>(".cm-atomic-table-cell-source");
      expect(input).not.toBeNull();
      input!.textContent = "changed";
      input!.dispatchEvent(new Event("input", { bubbles: true }));
      expect(editor.getSnapshot()?.source).toBe("before\n\n|A  | B|\n|---|---|\n| changed  |y |\n\nafter\n");
    } finally {
      dispose();
    }
  });
});

describe("vault-scoped wiki link rules", () => {
  const notes: WikiNote[] = [
    { noteId: "current", path: "folder/current.md", title: "Current" },
    { noteId: "sibling", path: "folder/sibling.md", title: "Sibling" },
    { noteId: "root", path: "root.md", title: "Root" },
    { noteId: "other-sibling", path: "other/sibling.md", title: "Sibling" },
  ];

  it("resolves explicit relative and root paths and rejects ambiguous basenames", () => {
    expect(resolveWikiTarget("../root", "folder/current.md", notes)).toStrictEqual({
      kind: "resolved",
      note: notes[2],
    });
    expect(resolveWikiTarget("/folder/current.md", "folder/current.md", notes)).toStrictEqual({
      kind: "resolved",
      note: notes[0],
    });
    expect(resolveWikiTarget("sibling", "folder/current.md", notes)).toMatchObject({
      kind: "ambiguous",
      noteIds: ["sibling", "other-sibling"],
    });
    expect(resolveWikiTarget("folder/sibling", "folder/current.md", notes)).toMatchObject({
      kind: "invalid",
    });
    expect(resolveWikiTarget("../../../escape", "folder/current.md", notes)).toMatchObject({
      kind: "invalid",
    });
  });

  it("suggests root-relative note targets", () => {
    expect(suggestWikiTargets("sibl", notes)).toStrictEqual([
      { target: "/folder/sibling.md", label: "Sibling", detail: "folder/sibling.md" },
      { target: "/other/sibling.md", label: "Sibling", detail: "other/sibling.md" },
    ]);
  });

  it("resolves links from the active vault and leaves ambiguous targets unresolved", async () => {
    let opened: string | null = null;
    const { container, dispose } = mounted("Open [[../root]] and [[sibling]]", {
      extensions: [createWikiLinkExtension()],
      currentNotePath: () => "folder/current.md",
      wikiNotes: () => notes,
      onWikiNoteOpen: (noteId) => { opened = noteId; },
    });
    try {
      await Promise.resolve();
      await Promise.resolve();
      const rootLink = container.querySelector<HTMLElement>('[data-wiki-link-target="../root"]');
      const siblingLink = container.querySelector<HTMLElement>('[data-wiki-link-target="sibling"]');
      expect(rootLink?.textContent).toBe("Root");
      expect(siblingLink?.className).toContain("unresolved");
      rootLink?.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
      siblingLink?.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
      expect(opened).toBe("root");
    } finally {
      dispose();
    }
  });
});
