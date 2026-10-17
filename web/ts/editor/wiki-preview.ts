import type { Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import type { WikiNote } from "./wiki-target.js";

const HOVER_DELAY_MS = 300;
const HIDE_DELAY_MS = 350;
const TARGET_SELECTOR = "[data-wiki-link-target]";

export type WikiPreviewOptions = {
  resolve: (target: string) => WikiNote | null;
  load: (noteId: string, signal: AbortSignal) => Promise<string>;
};

function targetElement(event: Event): HTMLElement | null {
  const origin = event.target;
  return origin instanceof Element ? origin.closest<HTMLElement>(TARGET_SELECTOR) : null;
}

export function wikiPreviewCards(options: WikiPreviewOptions): Extension {
  return ViewPlugin.fromClass(
    class {
      private card: HTMLElement | null = null;
      private anchor: HTMLElement | null = null;
      private showTimer: number | null = null;
      private hideTimer: number | null = null;
      private controller: AbortController | null = null;

      constructor(private readonly view: EditorView) {
        view.dom.addEventListener("pointerover", this.onPointerOver);
        view.dom.addEventListener("pointerout", this.onPointerOut);
        window.addEventListener("scroll", this.close, true);
        window.addEventListener("resize", this.close);
        window.addEventListener("keydown", this.onKeyDown, true);
      }

      update(update: ViewUpdate) {
        if (update.docChanged || update.selectionSet) this.close();
      }

      destroy() {
        this.close();
        this.view.dom.removeEventListener("pointerover", this.onPointerOver);
        this.view.dom.removeEventListener("pointerout", this.onPointerOut);
        window.removeEventListener("scroll", this.close, true);
        window.removeEventListener("resize", this.close);
        window.removeEventListener("keydown", this.onKeyDown, true);
      }

      private readonly onKeyDown = (event: KeyboardEvent) => {
        if (event.key === "Escape") this.close();
      };

      private readonly onPointerOver = (event: PointerEvent) => {
        const anchor = targetElement(event);
        if (anchor === null) return;
        if (anchor === this.anchor) {
          this.clearHideTimer();
          return;
        }
        const target = anchor.dataset["wikiLinkTarget"];
        if (target === undefined) return;
        const note = options.resolve(target);
        this.close();
        if (note === null) return;
        this.anchor = anchor;
        this.showTimer = window.setTimeout(() => {
          this.showTimer = null;
          this.open(note, anchor);
        }, HOVER_DELAY_MS);
      };

      private readonly onPointerOut = (event: PointerEvent) => {
        const anchor = targetElement(event);
        if (anchor === null || anchor !== this.anchor) return;
        const related = event.relatedTarget;
        if (related instanceof Node && (anchor.contains(related) || this.card?.contains(related))) return;
        this.scheduleClose();
      };

      private readonly close = () => {
        this.clearShowTimer();
        this.clearHideTimer();
        this.controller?.abort();
        this.controller = null;
        this.card?.remove();
        this.card = null;
        this.anchor = null;
      };

      private open(note: WikiNote, anchor: HTMLElement) {
        const controller = new AbortController();
        this.controller = controller;
        options.load(note.noteId, controller.signal).then((preview) => {
          if (controller.signal.aborted || this.anchor !== anchor) return;
          this.render(note, preview, anchor);
        }, () => undefined);
      }

      private render(note: WikiNote, preview: string, anchor: HTMLElement) {
        const card = document.createElement("div");
        card.className = "tansu-wiki-preview";
        card.setAttribute("role", "tooltip");
        const title = document.createElement("div");
        title.className = "tansu-wiki-preview-title";
        title.textContent = note.title;
        const path = document.createElement("div");
        path.className = "tansu-wiki-preview-path";
        path.textContent = note.path;
        const body = document.createElement("div");
        body.className = "tansu-wiki-preview-body";
        body.textContent = preview;
        const hint = document.createElement("div");
        hint.className = "tansu-wiki-preview-hint";
        hint.textContent = "click to open";
        card.append(title, path, body, hint);
        card.addEventListener("pointerenter", () => this.clearHideTimer());
        card.addEventListener("pointerleave", () => this.scheduleClose());
        document.body.append(card);
        this.card = card;
        this.position(card, anchor.getBoundingClientRect());
      }

      private position(card: HTMLElement, rect: DOMRect) {
        const { width, height } = card.getBoundingClientRect();
        const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
        card.style.left = `${left}px`;
        const below = rect.bottom + 6;
        card.style.top = `${below + height <= window.innerHeight - 8 ? below : Math.max(8, rect.top - height - 6)}px`;
      }

      private scheduleClose() {
        this.clearHideTimer();
        this.hideTimer = window.setTimeout(this.close, HIDE_DELAY_MS);
      }

      private clearShowTimer() {
        if (this.showTimer === null) return;
        window.clearTimeout(this.showTimer);
        this.showTimer = null;
      }

      private clearHideTimer() {
        if (this.hideTimer === null) return;
        window.clearTimeout(this.hideTimer);
        this.hideTimer = null;
      }
    },
  );
}
