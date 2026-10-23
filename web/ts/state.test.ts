import { expect, describe, it } from "vitest";

import {
  activeTab,
  createState,
  nextTheme,
  parseTheme,
  tabById,
  tabFromDocument,
  tabFromMeta,
  tabFromWorkspace,
  tabIdentity,
  toNoteId,
  workspaceTabFromTab,
  type NoteId,
} from "./state.ts";
import { vaultId } from "./app/identity.ts";
import type { V2NoteDocument, V2NoteMeta } from "./types.generated.ts";

describe("state helpers", () => {
  it("creates isolated state containers for vaults", () => {
    const first = createState(vaultId("vault-1"));
    const second = createState(vaultId("vault-2"));

    first.notes.set("n1", note("n1", "one.md", "One"));
    first.pinned.add("n1");

    expect(first.vault).toBe("vault-1");
    expect(second.vault).toBe("vault-2");
    expect(second.notes.size).toBe(0);
    expect(second.pinned.size).toBe(0);
  });

  it("cycles themes light, dark, paper and rejects unknown saved values", () => {
    expect(nextTheme("light")).toBe("dark");
    expect(nextTheme("dark")).toBe("paper");
    expect(nextTheme("paper")).toBe("light");
    expect(parseTheme(null)).toBe("light");
    expect(parseTheme("paper")).toBe("paper");
    expect(() => parseTheme("sepia")).toThrow(TypeError);
  });

  it("finds active and arbitrary saved tabs by note id", () => {
    const first = tabFromMeta(note("a", "a.md", "A"));
    const second = tabFromMeta(note("b", "b.md", "B"));
    const state = createState(vaultId("vault-1"));
    state.tabs = [first, second];
    state.activeTab = tabIdentity(second);

    expect(activeTab(state)?.path).toBe("b.md");
    expect(tabById(state, "a")?.title).toBe("A");
    expect(tabById(state, "missing")).toBeUndefined();
  });

  it("converts loaded documents to tabs and persists workspace editor state", () => {
    const document: V2NoteDocument = {
      meta: note("n1", "one.md", "One"),
      content: "# One\n",
    };
    const tab = tabFromDocument(document);
    tab.selection = { anchor: 5, head: 5 };
    tab.scrollTop = 240;
    tab.sourceMode = true;

    expect(tab.doc).toBe(document);
    expect(tab.draft).toBe("# One\n");
    const workspace = workspaceTabFromTab(tab);
    expect(workspace).toStrictEqual({
      kind: "saved",
      noteId: "n1",
      title: "One",
      path: "one.md",
      selection: { anchor: 5, head: 5 },
      scrollTop: 240,
      mode: "source",
    });

    const restored = tabFromWorkspace(workspace);
    expect(restored).toMatchObject({
      kind: "saved",
      noteId: toNoteId("n1"),
      selection: { anchor: 5, head: 5 },
      scrollTop: 240,
      sourceMode: true,
      draft: null,
      doc: null,
    });
  });
});

const plainNoteId = "plain";
// @ts-expect-error note ids must be explicitly branded before entering app state.
const brandedNoteId: NoteId = plainNoteId;
void brandedNoteId;

function note(noteId: string, path: string, title: string): V2NoteMeta {
  return {
    noteId,
    path,
    title,
    tags: [],
    revision: 1,
    sourceHash: `blake3-v3:${"a".repeat(64)}`,
    diskHash: `blake3-v2:${"b".repeat(64)}`,
    sourceHashFormatVersion: 3,
    diskHashFormatVersion: 2,
    updatedAtMs: 1,
  };
}
