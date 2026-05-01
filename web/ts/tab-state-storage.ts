import { getNote, saveState, getState, type SessionState } from "./api.ts";
import { kvGet, kvPut, noteGet, notePut } from "./local-store.ts";
import { getActiveVaultIndex } from "./vault-session.ts";

type StoredNote = {
  content: string;
  mtime: number;
  tags: string[];
  title?: string;
};

export function persistSessionState(state: SessionState): void {
  const vaultIndex = getActiveVaultIndex();
  /* c8 ignore start */
  kvPut(vaultIndex, "session", state).catch(() => void 0);
  saveState(state).catch(() => void 0);
  /* c8 ignore stop */
}

export function persistSessionCache(state: SessionState): void {
  const vaultIndex = getActiveVaultIndex();
  /* c8 ignore next */
  kvPut(vaultIndex, "session", state).catch(() => void 0);
}

export async function syncCachedSessionToServer(): Promise<void> {
  const cached = await kvGet<SessionState>(getActiveVaultIndex(), "session");
  if (cached) {
    saveState(cached).catch(() => void 0);
  }
}

export async function fetchNoteWithOfflineFallback(path: string): Promise<StoredNote> {
  const vaultIndex = getActiveVaultIndex();
  try {
    const note = await getNote(path);
    cacheNoteSnapshot(vaultIndex, path, note.content, note.mtime, note.tags);
    return note;
  } catch {
    const cached = await noteGet(vaultIndex, path);
    if (cached) {
      return cached;
    }
    throw new Error(`Note ${path} not available offline`);
  }
}

export function cacheNoteSnapshot(
  vaultIndex: number,
  path: string,
  content: string,
  mtime: number,
  tags: string[],
): void {
  /* c8 ignore start */
  notePut(vaultIndex, path, content, mtime, tags).catch(() => void 0);
  /* c8 ignore stop */
}

export async function loadSessionState(): Promise<SessionState> {
  const vaultIndex = getActiveVaultIndex();
  try {
    const state = await getState();
    kvPut(vaultIndex, "session", state).catch(() => void 0);
    return state;
  } catch {
    return (await kvGet<SessionState>(vaultIndex, "session")) ?? {};
  }
}
