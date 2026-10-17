import { describe, expect, it, vi } from "vitest";

import { GRAPH_NODE_LIMIT, LocalGraphView, layoutLocalGraph } from "./local-graph.ts";
import type { V2LinkedNote, V2NoteLinksResponse } from "./types.generated.ts";

function linked(id: string): V2LinkedNote {
  return { noteId: id, path: `${id}.md`, title: id.toUpperCase() };
}

function response(back: string[], out: string[]): V2NoteLinksResponse {
  return { backlinks: back.map((id) => ({ note: linked(id), mentions: [] })), outgoing: out.map(linked) };
}

const center = { noteId: "c", title: "C" };

describe("local graph layout", () => {
  it("is deterministic and centers the current note", () => {
    const links = response(["a", "b"], ["b", "d"]);
    const first = layoutLocalGraph(center, links, new Map());
    expect(layoutLocalGraph(center, links, new Map())).toStrictEqual(first);
    expect(first.nodes[0]).toStrictEqual({ noteId: "c", title: "C", hop: 0, x: 0, y: 0 });
    expect(first.nodes.map((node) => node.noteId)).toStrictEqual(["c", "a", "b", "d"]);
    expect(first.edges).toHaveLength(3);
  });

  it("never exceeds the node cap and fills spare room with second-hop notes", () => {
    const many = Array.from({ length: 40 }, (_, index) => `n${index}`);
    expect(layoutLocalGraph(center, response(many, []), new Map()).nodes).toHaveLength(GRAPH_NODE_LIMIT);

    const known = new Map([["a", response(["x1", "x2", "c"], ["x3", "a"])]]);
    const layout = layoutLocalGraph(center, response(["a"], []), known);
    expect(layout.nodes.filter((node) => node.hop === 2).map((node) => node.noteId)).toStrictEqual(["x1", "x2", "x3"]);

    const crowded = new Map(
      many.slice(0, 5).map((id) => [id, response(Array.from({ length: 30 }, (_, i) => `${id}-${i}`), [])] as const),
    );
    expect(layoutLocalGraph(center, response(many.slice(0, 5), []), crowded).nodes).toHaveLength(GRAPH_NODE_LIMIT);
  });
});

describe("local graph view", () => {
  it("reuses node elements across updates and opens neighbors on click", () => {
    vi.useFakeTimers();
    const view = new LocalGraphView();
    const open = vi.fn();
    view.update(layoutLocalGraph(center, response(["a"], []), new Map()), open);
    const before = view.element.querySelector<SVGGElement>('[data-note-id="a"]')!;
    before.dispatchEvent(new Event("click"));
    view.element.querySelector('[data-note-id="c"]')!.dispatchEvent(new Event("click"));
    expect(open).toHaveBeenCalledExactlyOnceWith("a");

    view.update(layoutLocalGraph({ noteId: "a", title: "A" }, response([], ["c"]), new Map()), open);
    expect(view.element.querySelector('[data-note-id="a"]')).toBe(before);
    expect(before.dataset["hop"]).toBe("0");
    vi.advanceTimersByTime(300);
    expect(view.element.querySelectorAll(".graph-node")).toHaveLength(2);
    vi.useRealTimers();
  });
});
