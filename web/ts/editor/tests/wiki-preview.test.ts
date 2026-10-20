import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCodeMirrorEditor } from "../codemirror-adapter.js";
import { createWikiLinkExtension } from "../tansu-extensions.js";
import type { WikiNote } from "../wiki-target.js";

const notes: WikiNote[] = [
  { noteId: "root", path: "root.md", title: "Root" },
  { noteId: "a", path: "a/same.md", title: "Same A" },
  { noteId: "b", path: "b/same.md", title: "Same B" },
];

const disposers: (() => void)[] = [];

function mounted(source: string, loadNotePreview: (id: string, signal: AbortSignal) => Promise<string>) {
  const container = document.createElement("div");
  document.body.append(container);
  const editor = createCodeMirrorEditor(container, {
    extensions: [createWikiLinkExtension()],
    currentNotePath: () => "current.md",
    wikiNotes: () => notes,
    loadNotePreview,
  });
  editor.attachSession(editor.createSession("current", source, { readOnly: true }));
  disposers.push(() => {
    editor.dispose();
    container.remove();
  });
  return container;
}

async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(0);
}

function hover(container: HTMLElement, target: string): HTMLElement {
  const link = container.querySelector<HTMLElement>(`[data-wiki-link-target="${target}"]`)!;
  link.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
  return link;
}

describe("wiki link hover preview", () => {
  beforeEach(() => vi.useFakeTimers());

  afterEach(() => {
    while (disposers.length > 0) disposers.pop()!();
    document.querySelectorAll(".tansu-wiki-preview").forEach((card) => card.remove());
    vi.useRealTimers();
  });
  it("loads the resolved note after the hover delay and shows the card", async () => {
    const load = vi.fn(async () => "Preview body");
    const container = mounted("See [[root]]", load);
    await settle();
    hover(container, "root");
    await vi.advanceTimersByTimeAsync(299);
    expect(load).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(load).toHaveBeenCalledWith("root", expect.any(AbortSignal));
    const card = document.querySelector(".tansu-wiki-preview")!;
    expect(card.textContent).toContain("Root");
    expect(card.textContent).toContain("root.md");
    expect(card.textContent).toContain("Preview body");
    expect(card.textContent).toContain("click to open");
  });

  it("does nothing for unresolved or ambiguous targets", async () => {
    const load = vi.fn(async () => "x");
    const container = mounted("[[missing]] [[same]]", load);
    await settle();
    for (const target of ["missing", "same"]) {
      container.querySelector<HTMLElement>(`[data-wiki-link-target="${target}"]`)
        ?.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    }
    await vi.advanceTimersByTimeAsync(1000);
    expect(load).not.toHaveBeenCalled();
    expect(document.querySelector(".tansu-wiki-preview")).toBeNull();
  });

  it("aborts a stale load when the pointer leaves and shows no card", async () => {
    let signal: AbortSignal | undefined;
    let finish: (text: string) => void = () => undefined;
    const load = vi.fn((_id: string, abort: AbortSignal) => {
      signal = abort;
      return new Promise<string>((resolve) => { finish = resolve; });
    });
    const container = mounted("See [[root]]", load);
    await settle();
    const link = hover(container, "root");
    await vi.advanceTimersByTimeAsync(300);
    link.dispatchEvent(new PointerEvent("pointerout", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(350);
    expect(signal?.aborted).toBeTruthy();
    finish("late");
    await settle();
    expect(document.querySelector(".tansu-wiki-preview")).toBeNull();
  });

  it("shows nothing when the load fails and closes on Escape", async () => {
    const container = mounted("[[root]]", async () => { throw new Error("offline"); });
    await settle();
    hover(container, "root");
    await vi.advanceTimersByTimeAsync(300);
    expect(document.querySelector(".tansu-wiki-preview")).toBeNull();

    const open = mounted("[[root]]", async () => "ok");
    await settle();
    hover(open, "root");
    await vi.advanceTimersByTimeAsync(300);
    expect(document.querySelector(".tansu-wiki-preview")).not.toBeNull();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(document.querySelector(".tansu-wiki-preview")).toBeNull();
  });
});
