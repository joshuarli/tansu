import type { EditorEvent } from "./editor-events.ts";
import { on, emit } from "./events.ts";

export type { EditorEvent };

export function dispatchEditorAction(e: EditorEvent): void {
  emit("editor:action", e);
}

export function onEditorAction(handler: (e: EditorEvent) => void): () => void {
  return on<EditorEvent>("editor:action", handler);
}
