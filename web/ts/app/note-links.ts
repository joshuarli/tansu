import type { V2NoteLinksResponse } from "../types.generated.ts";
import type { NoteLinksState } from "../state.ts";

export type NoteLinksOutcome = Exclude<NoteLinksState, { phase: "loading" }>;

export type NoteLinksLoader = {
  load: (noteId: string) => void;
  cancel: () => void;
};

export function createNoteLinksLoader(
  fetchLinks: (noteId: string, signal: AbortSignal) => Promise<V2NoteLinksResponse>,
  onOutcome: (outcome: NoteLinksOutcome) => void,
): NoteLinksLoader {
  let pending: AbortController | null = null;
  return {
    load(noteId) {
      pending?.abort();
      const controller = new AbortController();
      pending = controller;
      // oxlint-disable-next-line promise/catch-or-return, promise/prefer-catch -- Keep callback errors out of the fetch rejection handler.
      void fetchLinks(noteId, controller.signal).then(
        (links) => {
          if (pending === controller) onOutcome({ noteId, phase: "ready", links });
        },
        (error: unknown) => {
          if (pending !== controller || controller.signal.aborted) return;
          onOutcome({ noteId, phase: "error", message: error instanceof Error ? error.message : String(error) });
        },
      );
    },
    cancel() {
      pending?.abort();
      pending = null;
    },
  };
}

export const NOTE_PREVIEW_CACHE_LIMIT = 48;

export type NotePreviewCache = {
  load: (noteId: string) => Promise<string>;
  clear: () => void;
};

export function createNotePreviewCache(
  fetchPreview: (noteId: string) => Promise<string>,
  limit = NOTE_PREVIEW_CACHE_LIMIT,
): NotePreviewCache {
  const settled = new Map<string, string>();
  const inFlight = new Map<string, Promise<string>>();
  let generation = 0;
  return {
    load(noteId) {
      const cached = settled.get(noteId);
      if (cached !== undefined) {
        settled.delete(noteId);
        settled.set(noteId, cached);
        return Promise.resolve(cached);
      }
      const running = inFlight.get(noteId);
      if (running !== undefined) return running;
      const started = generation;
      const request = fetchPreview(noteId).then((preview) => {
        if (started === generation) {
          settled.set(noteId, preview);
          if (settled.size > limit) {
            const oldest = settled.keys().next();
            if (!oldest.done) settled.delete(oldest.value);
          }
        }
        return preview;
      }).finally(() => {
        if (inFlight.get(noteId) === request) inFlight.delete(noteId);
      });
      inFlight.set(noteId, request);
      return request;
    },
    clear() {
      generation += 1;
      settled.clear();
      inFlight.clear();
    },
  };
}
