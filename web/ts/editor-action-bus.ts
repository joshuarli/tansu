import { on, emit } from "./events.ts";
import type { EditorEvent } from "./editor-events.ts";

export type { EditorEvent };

export function dispatchEditorAction(e: EditorEvent): void {
  if (process.env["NODE_ENV"] === "development") {
    console.log(`%c[editor:${e.type}]`, "color:#888", e);
  }
  emit("editor:action", e);
}

export function onEditorAction(handler: (e: EditorEvent) => void): () => void {
  return on<EditorEvent>("editor:action", handler);
}
