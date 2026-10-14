import { StateField, Transaction, type EditorState, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type ViewUpdate } from "@codemirror/view";
import { readOnlyFacet } from "./vendor/atomic/read-only.js";

const MIN_WIDTH = 48;
const MAX_WIDTH = 2400;

type WikiImage = {
  from: number;
  to: number;
  source: string;
  name: string;
  width: number;
};

type Resize = {
  from: number;
  to: number;
  source: string;
  image: HTMLImageElement;
  startX: number;
  startWidth: number;
  width: number;
};

class WikiImagePreview extends WidgetType {
  constructor(
    private readonly image: WikiImage,
    private readonly url: string,
  ) {
    super();
  }

  override eq(other: WikiImagePreview): boolean {
    return this.image.source === other.image.source && this.url === other.url;
  }

  override toDOM(): HTMLElement {
    const wrapper = document.createElement("span");
    wrapper.className = "tansu-wiki-image";
    wrapper.dataset["from"] = String(this.image.from);
    wrapper.dataset["to"] = String(this.image.to);
    wrapper.dataset["source"] = this.image.source;
    const image = document.createElement("img");
    image.alt = this.image.name;
    image.src = this.url;
    image.width = this.image.width;
    image.dataset["imageName"] = this.image.name;
    wrapper.append(image);
    const resize = document.createElement("button");
    resize.type = "button";
    resize.className = "tansu-wiki-image-resize";
    resize.setAttribute("aria-label", `Resize ${this.image.name}`);
    resize.textContent = "↘";
    wrapper.append(resize);
    return wrapper;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

function findWikiImages(state: EditorState): WikiImage[] {
  const images: WikiImage[] = [];
  let fence: { marker: string; length: number } | null = null;
  for (let number = 1; number <= state.doc.lines; number++) {
    const line = state.doc.line(number);
    const fenceMatch = line.text.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence !== null) {
      if (fenceMatch && fenceMatch[1]![0] === fence.marker && fenceMatch[1]!.length >= fence.length) {
        fence = null;
      }
      continue;
    }
    if (fenceMatch) {
      fence = { marker: fenceMatch[1]![0]!, length: fenceMatch[1]!.length };
      continue;
    }

    const expression = /!\[\[([^\]|\n]+?)(?:\|(\d+))?\]\]/g;
    for (const match of line.text.matchAll(expression)) {
      const localFrom = match.index;
      if (localFrom === undefined || insideCodeSpan(line.text, localFrom)) continue;
      const name = match[1]!.trim();
      const width = Number(match[2]) || 320;
      if (name === "") continue;
      images.push({
        from: line.from + localFrom,
        to: line.from + localFrom + match[0].length,
        source: match[0],
        name,
        width: clampWidth(width),
      });
    }
  }
  return images;
}

function insideCodeSpan(line: string, position: number): boolean {
  const spans = line.matchAll(/(`+)(.*?)\1/g);
  for (const span of spans) {
    const start = span.index;
    if (start !== undefined && position >= start && position < start + span[0].length) return true;
  }
  return false;
}

function clampWidth(width: number): number {
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, width));
}

function buildWikiImageDecorations(
  state: EditorState,
  resolveUrl: (name: string) => string | null,
): ReturnType<typeof Decoration.set> {
  const ranges = [];
  for (const image of findWikiImages(state)) {
    const url = resolveUrl(image.name);
    if (url === null) continue;
    ranges.push(
      Decoration.replace({ widget: new WikiImagePreview(image, url) }).range(image.from, image.to),
    );
  }
  return Decoration.set(ranges, true);
}

export function wikiImages(options: { resolveUrl: (name: string) => string | null }): Extension {
  const field = StateField.define({
    create: (state) => buildWikiImageDecorations(state, options.resolveUrl),
    update: (decorations, transaction) =>
      transaction.docChanged
        ? buildWikiImageDecorations(transaction.state, options.resolveUrl)
        : decorations.map(transaction.changes),
    provide: (value) => EditorView.decorations.from(value),
  });

  const resizePlugin = ViewPlugin.fromClass(class {
    private resize: Resize | null = null;
    private readonly onDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || this.view.state.facet(readOnlyFacet)) return;
      const handle = target.closest<HTMLButtonElement>(".tansu-wiki-image-resize");
      const wrapper = handle?.closest<HTMLElement>(".tansu-wiki-image");
      const image = wrapper?.querySelector<HTMLImageElement>("img");
      if (!wrapper || !handle || !image) return;
      const from = Number(wrapper.dataset["from"]);
      const to = Number(wrapper.dataset["to"]);
      const source = wrapper.dataset["source"];
      if (!Number.isInteger(from) || !Number.isInteger(to) || source === undefined) return;
      if (this.view.state.doc.sliceString(from, to) !== source) return;
      event.preventDefault();
      event.stopPropagation();
      this.resize = {
        from,
        to,
        source,
        image,
        startX: event.clientX,
        startWidth: image.width || 320,
        width: image.width || 320,
      };
    };
    private readonly onMove = (event: PointerEvent) => {
      if (this.resize === null) return;
      event.preventDefault();
      this.resize.width = clampWidth(this.resize.startWidth + event.clientX - this.resize.startX);
      this.resize.image.width = this.resize.width;
      this.resize.image.style.width = `${this.resize.width}px`;
    };
    private readonly onUp = () => {
      const resize = this.resize;
      this.resize = null;
      if (resize === null || resize.width === resize.startWidth) return;
      if (this.view.state.facet(readOnlyFacet)) return;
      const current = this.view.state.doc.sliceString(resize.from, resize.to);
      if (current !== resize.source) return;
      const match = current.match(/^!\[\[([^\]|]+?)(?:\|\d+)?\]\]$/);
      if (match === null) return;
      const replacement = `![[${match[1]!.trim()}|${resize.width}]]`;
      this.view.dispatch({
        changes: { from: resize.from, to: resize.to, insert: replacement },
        annotations: Transaction.userEvent.of("input.image-resize"),
      });
    };

    constructor(private readonly view: EditorView) {
      view.dom.addEventListener("pointerdown", this.onDown, true);
      window.addEventListener("pointermove", this.onMove);
      window.addEventListener("pointerup", this.onUp);
      window.addEventListener("pointercancel", this.onUp);
    }

    update(update: ViewUpdate): void {
      if (this.resize !== null && update.docChanged) {
        this.resize.from = update.changes.mapPos(this.resize.from, 1);
        this.resize.to = update.changes.mapPos(this.resize.to, -1);
        if (update.state.doc.sliceString(this.resize.from, this.resize.to) !== this.resize.source) {
          this.resize = null;
        }
      }
    }

    destroy(): void {
      this.view.dom.removeEventListener("pointerdown", this.onDown, true);
      window.removeEventListener("pointermove", this.onMove);
      window.removeEventListener("pointerup", this.onUp);
      window.removeEventListener("pointercancel", this.onUp);
      this.resize = null;
    }
  });

  return [field, resizePlugin];
}
