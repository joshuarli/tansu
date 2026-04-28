import { getNote, saveState, getState, type SessionState } from "./api.ts";
import { kvGet, kvPut, noteGet, notePut } from "./local-store.ts";

export type StoredNote = {
  content: string;
  mtime: number;
  tags: string[];
};

export function persistSessionState(state: SessionState): void {
  /* c8 ignore start */
  kvPut("session", state).catch(() => void 0);
  saveState(state).catch(() => void 0);
  /* c8 ignore stop */
}

export function persistSessionCache(state: SessionState): void {
  /* c8 ignore next */
  kvPut("session", state).catch(() => void 0);
}

export async function syncCachedSessionToServer(): Promise<void> {
  const cached = await kvGet<SessionState>("session");
  if (cached) {
    saveState(cached).catch(() => void 0);
  }
}

export async function fetchNoteWithOfflineFallback(path: string): Promise<StoredNote> {
  try {
    const note = await getNote(path);
    cacheNoteSnapshot(path, note.content, note.mtime, note.tags);
    return note;
  } catch {
    const cached = await noteGet(path);
    if (cached) {
      return cached;
    }
    throw new Error(`Note ${path} not available offline`);
  }
}

export function cacheNoteSnapshot(
  path: string,
  content: string,
  mtime: number,
  tags: string[],
): void {
  /* c8 ignore start */
  notePut(path, content, mtime, tags).catch(() => void 0);
  /* c8 ignore stop */
}

export async function loadSessionState(): Promise<SessionState> {
  try {
    const state = await getState();
    persistSessionCache(state);
    return state;
  } catch {
    return (await kvGet<SessionState>("session")) ?? {};
  }
}
