import type { V2LinkedNote, V2NoteLinksResponse } from "./types.generated.ts";

export const GRAPH_NODE_LIMIT = 24;
const FIRST_RING_RADIUS = 56;
const SECOND_RING_RADIUS = 98;
const SECOND_RING_SPREAD_RADIANS = 0.3;
const LEAVING_MS = 220;
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const LABEL_LIMIT = 20;

export type GraphNode = {
  noteId: string;
  title: string;
  hop: 0 | 1 | 2;
  x: number;
  y: number;
};

export type GraphEdge = { from: string; to: string; hop: 1 | 2 };

export type GraphLayout = { nodes: GraphNode[]; edges: GraphEdge[] };

type LinkedNeighbors = readonly { noteId: string; title: string }[];

function neighborsOf(links: V2NoteLinksResponse): LinkedNeighbors {
  return [...links.backlinks.map((backlink) => backlink.note), ...links.outgoing];
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function polar(radius: number, angle: number): { x: number; y: number } {
  return { x: round(radius * Math.cos(angle)), y: round(radius * Math.sin(angle)) };
}

export function layoutLocalGraph(
  center: Pick<V2LinkedNote, "noteId" | "title">,
  links: V2NoteLinksResponse,
  known: ReadonlyMap<string, V2NoteLinksResponse>,
): GraphLayout {
  const seen = new Set<string>([center.noteId]);
  const firstHop: { noteId: string; title: string }[] = [];
  for (const neighbor of neighborsOf(links)) {
    if (seen.has(neighbor.noteId) || firstHop.length >= GRAPH_NODE_LIMIT - 1) continue;
    seen.add(neighbor.noteId);
    firstHop.push({ noteId: neighbor.noteId, title: neighbor.title });
  }

  const nodes: GraphNode[] = [{ noteId: center.noteId, title: center.title, hop: 0, x: 0, y: 0 }];
  const edges: GraphEdge[] = [];
  const parentAngles = new Map<string, number>();
  firstHop.forEach((neighbor, index) => {
    const angle = -Math.PI / 2 + (2 * Math.PI * index) / firstHop.length;
    parentAngles.set(neighbor.noteId, angle);
    nodes.push({ ...neighbor, hop: 1, ...polar(FIRST_RING_RADIUS, angle) });
    edges.push({ from: neighbor.noteId, to: center.noteId, hop: 1 });
  });

  for (const parent of firstHop) {
    const parentLinks = known.get(parent.noteId);
    if (parentLinks === undefined) continue;
    const children: { noteId: string; title: string }[] = [];
    for (const neighbor of neighborsOf(parentLinks)) {
      if (seen.has(neighbor.noteId) || nodes.length + children.length >= GRAPH_NODE_LIMIT) continue;
      seen.add(neighbor.noteId);
      children.push({ noteId: neighbor.noteId, title: neighbor.title });
    }
    const parentAngle = parentAngles.get(parent.noteId)!;
    children.forEach((child, index) => {
      const angle = parentAngle + (index - (children.length - 1) / 2) * SECOND_RING_SPREAD_RADIANS;
      nodes.push({ ...child, hop: 2, ...polar(SECOND_RING_RADIUS, angle) });
      edges.push({ from: parent.noteId, to: child.noteId, hop: 2 });
    });
  }
  return { nodes, edges };
}

function svgElement<K extends keyof SVGElementTagNameMap>(tag: K, className: string): SVGElementTagNameMap[K] {
  const element = document.createElementNS(SVG_NAMESPACE, tag);
  element.setAttribute("class", className);
  return element;
}

function truncatedLabel(title: string): string {
  return title.length <= LABEL_LIMIT ? title : `${title.slice(0, LABEL_LIMIT - 1)}…`;
}

function edgeKey(edge: GraphEdge): string {
  return `${edge.from}>${edge.to}`;
}

function edgeTransform(layout: GraphLayout, edge: GraphEdge): string {
  const from = layout.nodes.find((node) => node.noteId === edge.from)!;
  const to = layout.nodes.find((node) => node.noteId === edge.to)!;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const angle = round((Math.atan2(dy, dx) * 180) / Math.PI);
  return `translate(${from.x}px, ${from.y}px) rotate(${angle}deg) scale(${round(Math.hypot(dx, dy))}, 1)`;
}

export class LocalGraphView {
  readonly element: SVGSVGElement;
  private readonly edgeLayer: SVGGElement;
  private readonly nodeLayer: SVGGElement;
  private readonly nodes = new Map<string, SVGGElement>();
  private readonly edges = new Map<string, SVGLineElement>();
  private readonly leaving = new Map<Element, number>();
  private onOpen: (noteId: string) => void = () => undefined;

  constructor() {
    this.element = document.createElementNS(SVG_NAMESPACE, "svg");
    this.element.setAttribute("class", "local-graph");
    this.element.setAttribute("viewBox", "-120 -120 240 240");
    this.element.setAttribute("role", "group");
    this.element.setAttribute("aria-label", "Local link graph");
    this.edgeLayer = svgElement("g", "graph-edges");
    this.nodeLayer = svgElement("g", "graph-nodes");
    this.element.append(this.edgeLayer, this.nodeLayer);
  }

  update(layout: GraphLayout, onOpen: (noteId: string) => void): SVGSVGElement {
    this.onOpen = onOpen;
    this.syncEdges(layout);
    this.syncNodes(layout);
    return this.element;
  }

  private syncEdges(layout: GraphLayout): void {
    const wanted = new Set(layout.edges.map(edgeKey));
    for (const edge of layout.edges) {
      const key = edgeKey(edge);
      let line = this.edges.get(key);
      if (line === undefined) {
        line = svgElement("line", "graph-edge");
        line.setAttribute("x2", "1");
        this.edges.set(key, line);
        this.edgeLayer.append(line);
      }
      this.revive(line);
      line.dataset["hop"] = String(edge.hop);
      line.style.transform = edgeTransform(layout, edge);
    }
    this.retire(this.edges, wanted);
  }

  private syncNodes(layout: GraphLayout): void {
    const wanted = new Set(layout.nodes.map((node) => node.noteId));
    for (const node of layout.nodes) {
      let group = this.nodes.get(node.noteId);
      if (group === undefined) {
        group = svgElement("g", "graph-node");
        const circle = svgElement("circle", "graph-dot");
        const label = svgElement("text", "graph-label");
        const tooltip = document.createElementNS(SVG_NAMESPACE, "title");
        group.append(tooltip, circle, label);
        group.addEventListener("click", () => {
          if (group!.dataset["hop"] !== "0") this.onOpen(group!.dataset["noteId"]!);
        });
        this.nodes.set(node.noteId, group);
        this.nodeLayer.append(group);
      }
      this.revive(group);
      group.dataset["noteId"] = node.noteId;
      group.dataset["hop"] = String(node.hop);
      group.style.transform = `translate(${node.x}px, ${node.y}px)`;
      group.querySelector("title")!.textContent = node.title;
      group.querySelector("text")!.textContent = truncatedLabel(node.title);
      group.querySelector("circle")!.setAttribute("r", node.hop === 0 ? "7" : node.hop === 1 ? "4.5" : "3");
    }
    this.retire(this.nodes, wanted);
  }

  private revive(element: Element): void {
    const timer = this.leaving.get(element);
    if (timer === undefined) return;
    window.clearTimeout(timer);
    this.leaving.delete(element);
    element.classList.remove("leaving");
  }

  private retire<T extends Element>(registry: Map<string, T>, wanted: ReadonlySet<string>): void {
    for (const [key, element] of registry) {
      if (wanted.has(key) || this.leaving.has(element)) continue;
      element.classList.add("leaving");
      this.leaving.set(element, window.setTimeout(() => {
        element.remove();
        this.leaving.delete(element);
        registry.delete(key);
      }, LEAVING_MS));
    }
  }
}
