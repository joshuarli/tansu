import { fitFrame, generateOrnament, type FramePreset, type OrnamentPreset } from "./vendor/alembic-ornaments/index.ts";

type FrameSurface = {
  selector: string;
  preset: FramePreset;
  seed: number;
};

const FRAME_SURFACES: readonly FrameSurface[] = [
  { selector: ".settings-panel", preset: "block", seed: 2 },
  { selector: ".history-edge-panel", preset: "block", seed: 6 },
  { selector: ".command-panel", preset: "border", seed: 4 },
  { selector: ".modal-panel", preset: "border", seed: 9 },
  { selector: ".auth-card", preset: "corners", seed: 3 },
];

type NamedOrnament = {
  name: string;
  preset: OrnamentPreset;
  seed: number;
};

const NAMED_ORNAMENTS: readonly NamedOrnament[] = [
  { name: "vine", preset: "vine", seed: 7 },
  { name: "garland", preset: "garland", seed: 5 },
  { name: "sprig", preset: "sprig", seed: 11 },
];

const FRAME_LAYER_CLASS = "skin-frame-layer";
const FRAME_SIZE_PROPERTY = "--skin-frame-size";

function surfaceFor(element: Element): FrameSurface | undefined {
  return FRAME_SURFACES.find((surface) => element.matches(surface.selector));
}

function frameSize(host: HTMLElement): number {
  const size = Number.parseFloat(getComputedStyle(host).getPropertyValue(FRAME_SIZE_PROPERTY));
  if (!(size > 0)) throw new Error(`${FRAME_SIZE_PROPERTY} is not set on ${host.className}`);
  return size;
}

function drawFrame(host: HTMLElement, layer: HTMLElement, surface: FrameSurface): void {
  const frame = fitFrame(
    { preset: surface.preset, seed: surface.seed, size: frameSize(host) },
    host.clientWidth,
    host.clientHeight,
  );
  if (frame === null) {
    layer.replaceChildren();
    return;
  }
  layer.innerHTML = frame.svg;
  const drawing = layer.firstElementChild;
  if (drawing === null) throw new Error("ornament frame produced no drawing");
  drawing.setAttribute("width", "100%");
  drawing.setAttribute("height", "100%");
  drawing.setAttribute("preserveAspectRatio", "none");
  drawing.setAttribute("style", "display:block");
}

function createLayer(): HTMLElement {
  const layer = document.createElement("div");
  layer.className = FRAME_LAYER_CLASS;
  layer.setAttribute("aria-hidden", "true");
  return layer;
}

type Decoration = { layer: HTMLElement; surface: FrameSurface };

class FrameDecorator {
  private readonly decorations = new Map<HTMLElement, Decoration>();
  private readonly resizes = new ResizeObserver((entries) => {
    for (const { target } of entries) {
      const decoration = target instanceof HTMLElement ? this.decorations.get(target) : undefined;
      if (decoration !== undefined && target instanceof HTMLElement) {
        drawFrame(target, decoration.layer, decoration.surface);
      }
    }
  });

  decorateTree(root: Element): void {
    for (const candidate of [root, ...root.querySelectorAll("*")]) {
      if (candidate instanceof HTMLElement) this.decorate(candidate);
    }
  }

  releaseTree(root: Element): void {
    for (const candidate of [root, ...root.querySelectorAll("*")]) {
      if (candidate instanceof HTMLElement && this.decorations.delete(candidate)) this.resizes.unobserve(candidate);
    }
  }

  restoreLayer(host: Element): void {
    const decoration = host instanceof HTMLElement ? this.decorations.get(host) : undefined;
    if (decoration !== undefined && !decoration.layer.isConnected) host.append(decoration.layer);
  }

  private decorate(host: HTMLElement): void {
    if (this.decorations.has(host)) return;
    const surface = surfaceFor(host);
    if (surface === undefined) return;
    const layer = host.querySelector<HTMLElement>(`:scope > .${FRAME_LAYER_CLASS}`) ?? createLayer();
    host.append(layer);
    this.decorations.set(host, { layer, surface });
    drawFrame(host, layer, surface);
    this.resizes.observe(host);
  }
}

function isFrameLayer(node: Node): boolean {
  return node instanceof Element && node.closest(`.${FRAME_LAYER_CLASS}`) !== null;
}

function publishOrnaments(target: HTMLElement): void {
  for (const { name, preset, seed } of NAMED_ORNAMENTS) {
    const ornament = generateOrnament({ preset, seed });
    target.style.setProperty(`--skin-${name}`, `url("data:image/svg+xml,${encodeURIComponent(ornament.svg)}")`);
    target.style.setProperty(`--skin-${name}-aspect`, String(ornament.width / ornament.height));
  }
}

export function installAlembicSkin(root: HTMLElement): void {
  publishOrnaments(document.documentElement);
  const decorator = new FrameDecorator();
  decorator.decorateTree(root);
  new MutationObserver((records) => {
    for (const record of records) {
      if (isFrameLayer(record.target)) continue;
      for (const removed of record.removedNodes) {
        if (removed instanceof Element && !isFrameLayer(removed)) decorator.releaseTree(removed);
      }
      for (const added of record.addedNodes) {
        if (added instanceof Element && !isFrameLayer(added)) decorator.decorateTree(added);
      }
      if (record.target instanceof Element) decorator.restoreLayer(record.target);
    }
  }).observe(root, { childList: true, subtree: true });
}
