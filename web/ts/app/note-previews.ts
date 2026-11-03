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
