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
  imageName: string;
  image: HTMLImageElement;
  mode: "drag" | "pinch" | "wheel" | "gesture";
  pointerId: number | null;
  startX: number;
  startDistance: number;
  startWidth: number;
  width: number;
  frame: number | null;
};

type TouchPoint = { wrapper: HTMLElement; x: number; y: number };

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
    wrapper.dataset["imageName"] = this.image.name;
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

export function visibleWikiImageNames(view: EditorView): readonly string[] {
  const viewport = view.scrollDOM.getBoundingClientRect();
  const documentTop = view.documentTop;
  const names = new Set<string>();
  const images = findWikiImages(view.state);
  for (const image of images) {
    const block = view.lineBlockAt(image.from);
    const top = documentTop + block.top;
    const bottom = documentTop + block.bottom;
    if (top < viewport.bottom && bottom > viewport.top) {
      names.add(image.name);
    }
  }
  return [...names];
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
    private readonly touchPoints = new Map<number, TouchPoint>();
    private wheelEnd: number | null = null;

    private readonly onDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || this.view.state.facet(readOnlyFacet)) return;
      const wrapper = target.closest<HTMLElement>(".tansu-wiki-image, .tansu-resizable-image");
      if (wrapper === null) return;
      if (event.pointerType === "touch") {
        const pointerId = this.pointerId(event);
        this.touchPoints.set(pointerId, { wrapper, x: event.clientX, y: event.clientY });
        event.preventDefault();
        event.stopPropagation();
        if (this.touchPoints.size === 2) {
          const points = [...this.touchPoints.entries()];
          if (points[0]![1].wrapper !== wrapper || points[1]![1].wrapper !== wrapper) {
            this.touchPoints.clear();
            return;
          }
          const resize = this.startResize(wrapper, "pinch", null);
          if (resize !== null) resize.startDistance = this.distance(points[0]![1], points[1]![1]);
        }
        return;
      }
      const handle = target.closest<HTMLButtonElement>(".tansu-wiki-image-resize");
      if (handle === null) return;
      const resize = this.startResize(wrapper, "drag", this.pointerId(event));
      if (resize === null) return;
      event.preventDefault();
      event.stopPropagation();
      resize.startX = event.clientX;
    };

    private readonly onMove = (event: PointerEvent) => {
      const pointerId = this.pointerId(event);
      const point = this.touchPoints.get(pointerId);
      if (point !== undefined) {
        point.x = event.clientX;
        point.y = event.clientY;
        if (this.resize?.mode === "pinch" && this.touchPoints.size >= 2) {
          const points = [...this.touchPoints.values()];
          event.preventDefault();
          event.stopPropagation();
          this.resize.width = this.clampGestureWidth(
            this.resize.startWidth * this.distance(points[0]!, points[1]!) / this.resize.startDistance,
          );
          this.preview();
        }
        return;
      }
      const resize = this.resize;
      if (resize?.mode !== "drag" || resize.pointerId !== pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      resize.width = this.clampGestureWidth(resize.startWidth + event.clientX - resize.startX);
      this.preview();
    };

    private readonly onUp = (event: PointerEvent) => {
      const pointerId = this.pointerId(event);
      const wasTouch = this.touchPoints.delete(pointerId);
      if (event.type === "pointercancel") {
        this.touchPoints.clear();
        this.finishResize(false);
        return;
      }
      const resize = this.resize;
      if (resize?.mode === "pinch" && wasTouch && this.touchPoints.size < 2) {
        this.finishResize(true);
      } else if (resize?.mode === "drag" && resize.pointerId === pointerId) {
        this.finishResize(true);
      }
    };

    private readonly onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey || this.view.state.facet(readOnlyFacet)) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const wrapper = target.closest<HTMLElement>(".tansu-wiki-image, .tansu-resizable-image");
      if (wrapper === null) return;
      event.preventDefault();
      event.stopPropagation();
      if (this.resize?.mode !== "wheel" || this.resize.image !== wrapper.querySelector("img")) {
        this.finishResize(true);
        if (this.startResize(wrapper, "wheel", null) === null) return;
      }
      const resize = this.resize;
      if (resize === null) return;
      resize.width = this.clampGestureWidth(resize.width * Math.exp(-event.deltaY * 0.003));
      this.preview();
      if (this.wheelEnd !== null) window.clearTimeout(this.wheelEnd);
      this.wheelEnd = window.setTimeout(() => {
        this.wheelEnd = null;
        this.finishResize(true);
      }, 160);
    };

    private readonly onGestureStart = (event: Event) => {
      if (this.view.state.facet(readOnlyFacet)) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const wrapper = target.closest<HTMLElement>(".tansu-wiki-image, .tansu-resizable-image");
      if (wrapper === null) return;
      event.preventDefault();
      event.stopPropagation();
      this.finishResize(true);
      this.startResize(wrapper, "gesture", null);
    };

    private readonly onGestureChange = (event: Event) => {
      const resize = this.resize;
      if (resize?.mode !== "gesture") return;
      const scale = (event as Event & { scale: number }).scale;
      if (!Number.isFinite(scale)) return;
      event.preventDefault();
      event.stopPropagation();
      resize.width = this.clampGestureWidth(resize.startWidth * scale);
      this.preview();
    };

    private readonly onGestureEnd = (event: Event) => {
      if (this.resize?.mode !== "gesture") return;
      event.preventDefault();
      event.stopPropagation();
      this.finishResize(true);
    };

    constructor(private readonly view: EditorView) {
      view.dom.addEventListener("pointerdown", this.onDown, true);
      window.addEventListener("pointermove", this.onMove);
      window.addEventListener("pointerup", this.onUp);
      window.addEventListener("pointercancel", this.onUp);
      view.dom.addEventListener("wheel", this.onWheel, { capture: true, passive: false });
      view.dom.addEventListener("gesturestart", this.onGestureStart, { capture: true, passive: false });
      view.dom.addEventListener("gesturechange", this.onGestureChange, { capture: true, passive: false });
      view.dom.addEventListener("gestureend", this.onGestureEnd, { capture: true, passive: false });
    }

    update(update: ViewUpdate): void {
      if (this.resize !== null && update.docChanged) {
        this.resize.from = update.changes.mapPos(this.resize.from, 1);
        this.resize.to = update.changes.mapPos(this.resize.to, -1);
        if (update.state.doc.sliceString(this.resize.from, this.resize.to) !== this.resize.source) {
          this.finishResize(false);
        }
      }
    }

    destroy(): void {
      this.view.dom.removeEventListener("pointerdown", this.onDown, true);
      window.removeEventListener("pointermove", this.onMove);
      window.removeEventListener("pointerup", this.onUp);
      window.removeEventListener("pointercancel", this.onUp);
      this.view.dom.removeEventListener("wheel", this.onWheel, true);
      this.view.dom.removeEventListener("gesturestart", this.onGestureStart, true);
      this.view.dom.removeEventListener("gesturechange", this.onGestureChange, true);
      this.view.dom.removeEventListener("gestureend", this.onGestureEnd, true);
      this.touchPoints.clear();
      if (this.wheelEnd !== null) window.clearTimeout(this.wheelEnd);
      this.finishResize(false);
    }

    private startResize(wrapper: HTMLElement, mode: Resize["mode"], pointerId: number | null): Resize | null {
      const image = wrapper.querySelector<HTMLImageElement>("img");
      const source = wrapper.dataset["source"];
      const imageName = wrapper.dataset["imageName"];
      if (!image || source === undefined || imageName === undefined || imageName === "" ||
        imageName.includes("|") || imageName.includes("]") || /[\r\n]/.test(imageName)) return null;
      const range = this.sourceRange(wrapper, source);
      if (range === null) return null;
      this.finishResize(false);
      const startWidth = Math.round(this.clampGestureWidth(
        image.getBoundingClientRect().width || image.width || 320,
      ));
      this.resize = {
        ...range,
        source,
        imageName,
        image,
        mode,
        pointerId,
        startX: 0,
        startDistance: 1,
        startWidth,
        width: startWidth,
        frame: null,
      };
      return this.resize;
    }

    private preview(): void {
      const resize = this.resize;
      if (resize === null || resize.frame !== null) return;
      resize.frame = window.requestAnimationFrame(() => {
        if (this.resize !== resize) return;
        resize.frame = null;
        resize.image.style.width = `${resize.width}px`;
      });
    }

    private finishResize(commit: boolean): void {
      if (this.wheelEnd !== null) {
        window.clearTimeout(this.wheelEnd);
        this.wheelEnd = null;
      }
      const resize = this.resize;
      this.resize = null;
      if (resize === null) return;
      if (resize.frame !== null) window.cancelAnimationFrame(resize.frame);
      const width = Math.round(resize.width);
      resize.image.style.width = "";
      if (!commit || width === resize.startWidth || this.view.state.facet(readOnlyFacet)) return;
      const current = this.view.state.doc.sliceString(resize.from, resize.to);
      if (current !== resize.source) return;
      this.view.dispatch({
        changes: { from: resize.from, to: resize.to, insert: `![[${resize.imageName}|${width}]]` },
        annotations: Transaction.userEvent.of("input.image-resize"),
      });
    }

    private sourceRange(wrapper: HTMLElement, source: string): { from: number; to: number } | null {
      const doc = this.view.state.doc;
      const from = Number(wrapper.dataset["from"]);
      const to = Number(wrapper.dataset["to"]);
      if (Number.isInteger(from) && Number.isInteger(to) && doc.sliceString(from, to) === source) {
        return { from, to };
      }

      const position = this.view.posAtDOM(wrapper);
      const anchors = (wrapper.classList.contains("tansu-resizable-image") ? [position - 1] : [position, position - 1])
        .filter((anchor) => anchor >= 0 && anchor <= doc.length);
      const lines = new Set(anchors.map((anchor) => doc.lineAt(anchor).number));
      const candidates: { from: number; to: number }[] = [];
      for (const number of lines) {
        const line = doc.line(number);
        let index = line.text.indexOf(source);
        while (index !== -1) {
          candidates.push({ from: line.from + index, to: line.from + index + source.length });
          index = line.text.indexOf(source, index + 1);
        }
      }
      if (candidates.length === 0) return null;
      candidates.sort((left, right) =>
        Math.abs(left.from - position) - Math.abs(right.from - position)
      );
      return candidates[0]!;
    }

    private clampGestureWidth(width: number): number {
      const containerWidth = this.view.contentDOM.clientWidth || MAX_WIDTH;
      return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, containerWidth, width));
    }

    private pointerId(event: PointerEvent): number {
      return Number.isInteger(event.pointerId) ? event.pointerId : -1;
    }

    private distance(left: TouchPoint, right: TouchPoint): number {
      return Math.max(1, Math.hypot(left.x - right.x, left.y - right.y));
    }
  });

  return [field, resizePlugin];
}
