import type {
  AppStatus,
  ContentResponse,
  CreateNoteRequest,
  FileSearchResult,
  FilenameResponse,
  NoteEntry,
  NoteResponse,
  OkResponse,
  PinRequest,
  PinnedFileEntry,
  PrfRegisterRequest,
  PrfRemoveRequest,
  PutNoteRequest,
  RecentFileEntry,
  RenameRequest,
  RenameResponse,
  SaveResult,
  SearchHit,
  SessionState,
  Settings,
  UnlockRequest,
  VaultEntry,
} from "./api.generated.ts";

export type {
  AppStatus,
  ContentResponse,
  CreateNoteRequest,
  FileSearchResult,
  FilenameResponse,
  NoteEntry,
  NoteResponse,
  OkResponse,
  PinRequest,
  PinnedFileEntry,
  PrfRegisterRequest,
  PrfRemoveRequest,
  PutNoteRequest,
  RecentFileEntry,
  RenameRequest,
  RenameResponse,
  SaveResult,
  SearchHit,
  SessionState,
  Settings,
  UnlockRequest,
  VaultEntry,
};

export type Note = NoteResponse;
export type SearchResult = SearchHit;

async function readJson<T>(res: Response, ctx: string): Promise<T> {
  try {
    return (await res.json()) as T;
  } catch (error) {
    throw new Error(
      `${ctx}: invalid JSON${error instanceof Error && error.message ? ` (${error.message})` : ""}`,
      { cause: error },
    );
  }
}

export async function searchNotes(q: string, path?: string): Promise<SearchResult[]> {
  let url = `/api/search?q=${encodeURIComponent(q)}`;
  if (path) {
    url += `&path=${encodeURIComponent(path)}`;
  }
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`search failed: ${res.status}`);
  }
  return readJson<SearchResult[]>(res, "search");
}

export async function getNote(path: string): Promise<Note> {
  const res = await fetch(`/api/note?path=${encodeURIComponent(path)}`);
  if (!res.ok) {
    throw new Error(`get note failed: ${res.status}`);
  }
  return readJson<Note>(res, "get note");
}

export async function saveNote(
  path: string,
  content: string,
  expectedMtime: number,
): Promise<SaveResult> {
  const res = await fetch(`/api/note?path=${encodeURIComponent(path)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, expected_mtime: expectedMtime } satisfies PutNoteRequest),
  });
  const data = await readJson<SaveResult>(res, "save note");
  if (res.status === 409) {
    return { ...data, conflict: true };
  }
  if (!res.ok) {
    throw new Error(`save failed: ${res.status}`);
  }
  return data;
}

// Unconditional overwrite — server treats expected_mtime=0 as "skip conflict check".
export function forceSaveNote(path: string, content: string): Promise<SaveResult> {
  return saveNote(path, content, 0);
}

export async function createNote(path: string): Promise<SaveResult> {
  const res = await fetch(`/api/note?path=${encodeURIComponent(path)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: "" } satisfies CreateNoteRequest),
  });
  if (!res.ok) {
    throw new Error(`create failed: ${res.status}`);
  }
  return readJson<SaveResult>(res, "create note");
}

export async function deleteNote(path: string): Promise<void> {
  const res = await fetch(`/api/note?path=${encodeURIComponent(path)}`, { method: "DELETE" });
  if (!res.ok) {
    throw new Error(`delete failed: ${res.status}`);
  }
}

export async function renameNote(oldPath: string, newPath: string): Promise<RenameResponse> {
  const res = await fetch("/api/rename", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ old_path: oldPath, new_path: newPath } satisfies RenameRequest),
  });
  if (!res.ok) {
    throw new Error(`rename failed: ${res.status}`);
  }
  return readJson<RenameResponse>(res, "rename note");
}

export async function listNotes(): Promise<NoteEntry[]> {
  const res = await fetch("/api/notes");
  if (!res.ok) {
    throw new Error(`list failed: ${res.status}`);
  }
  return readJson<NoteEntry[]>(res, "list notes");
}

export async function searchFileNames(q: string): Promise<FileSearchResult[]> {
  const res = await fetch(`/api/filesearch?q=${encodeURIComponent(q)}`);
  if (!res.ok) {
    throw new Error(`filesearch failed: ${res.status}`);
  }
  return readJson<FileSearchResult[]>(res, "search file names");
}

export async function getRecentFiles(): Promise<RecentFileEntry[]> {
  const res = await fetch("/api/recentfiles");
  if (!res.ok) {
    throw new Error(`recentfiles failed: ${res.status}`);
  }
  return readJson<RecentFileEntry[]>(res, "recent files");
}

export async function getPinnedFiles(): Promise<PinnedFileEntry[]> {
  const res = await fetch("/api/pinned");
  if (!res.ok) {
    throw new Error(`pinned failed: ${res.status}`);
  }
  return readJson<PinnedFileEntry[]>(res, "pinned files");
}

export async function pinFile(path: string): Promise<void> {
  const res = await fetch("/api/pin", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path } satisfies PinRequest),
  });
  if (!res.ok) {
    throw new Error(`pin failed: ${res.status}`);
  }
}

export async function unpinFile(path: string): Promise<void> {
  const res = await fetch("/api/pin", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path } satisfies PinRequest),
  });
  if (!res.ok) {
    throw new Error(`unpin failed: ${res.status}`);
  }
}

export async function getBacklinks(path: string): Promise<string[]> {
  const res = await fetch(`/api/backlinks?path=${encodeURIComponent(path)}`);
  if (!res.ok) {
    throw new Error(`backlinks failed: ${res.status}`);
  }
  return readJson<string[]>(res, "backlinks");
}

export async function uploadImage(blob: Blob, filename: string): Promise<string> {
  const res = await fetch("/api/image", {
    method: "POST",
    headers: { "X-Filename": filename },
    body: blob,
  });
  if (!res.ok) {
    throw new Error(`upload failed: ${res.status}`);
  }
  const data = await readJson<FilenameResponse>(res, "upload image");
  return data.filename;
}

export async function listRevisions(path: string): Promise<number[]> {
  const res = await fetch(`/api/revisions?path=${encodeURIComponent(path)}`);
  if (!res.ok) {
    throw new Error(`revisions failed: ${res.status}`);
  }
  return readJson<number[]>(res, "list revisions");
}

export async function getRevision(path: string, ts: number): Promise<string> {
  const res = await fetch(`/api/revision?path=${encodeURIComponent(path)}&ts=${ts}`);
  if (!res.ok) {
    throw new Error(`revision failed: ${res.status}`);
  }
  const data = await readJson<ContentResponse>(res, "get revision");
  return data.content;
}

export async function restoreRevision(path: string, ts: number): Promise<SaveResult> {
  const res = await fetch(`/api/restore?path=${encodeURIComponent(path)}&ts=${ts}`, {
    method: "POST",
  });
  if (!res.ok) {
    throw new Error(`restore failed: ${res.status}`);
  }
  return readJson<SaveResult>(res, "restore revision");
}

export async function getState(): Promise<SessionState> {
  const res = await fetch("/api/state");
  if (!res.ok) {
    throw new Error(`state failed: ${res.status}`);
  }
  return readJson<SessionState>(res, "get state");
}

export async function saveState(state: SessionState): Promise<void> {
  await fetch("/api/state", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(state),
  });
}

export async function getStatus(): Promise<AppStatus> {
  const res = await fetch("/api/status");
  if (!res.ok) {
    throw new Error(`status failed: ${res.status}`);
  }
  return readJson<AppStatus>(res, "get status");
}

export async function unlockWithRecoveryKey(recoveryKey: string): Promise<boolean> {
  const res = await fetch("/api/unlock", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ recovery_key: recoveryKey } satisfies UnlockRequest),
  });
  return res.ok;
}

export async function unlockWithPrf(prfKeyB64: string): Promise<boolean> {
  const res = await fetch("/api/unlock", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prf_key: prfKeyB64 } satisfies UnlockRequest),
  });
  return res.ok;
}

export async function lockApp(): Promise<void> {
  await fetch("/api/lock");
}

export async function registerPrf(
  credentialId: string,
  prfKeyB64: string,
  name: string,
): Promise<boolean> {
  const body: PrfRegisterRequest = {
    credential_id: credentialId,
    prf_key: prfKeyB64,
    name,
  };
  const res = await fetch("/api/prf/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.ok;
}

export async function removePrf(credentialId: string): Promise<boolean> {
  const body: PrfRemoveRequest = { credential_id: credentialId };
  const res = await fetch("/api/prf/remove", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.ok;
}

export async function getSettings(): Promise<Settings> {
  const res = await fetch("/api/settings");
  if (!res.ok) {
    throw new Error(`settings failed: ${res.status}`);
  }
  return readJson<Settings>(res, "get settings");
}

export async function saveSettings(settings: Settings): Promise<void> {
  const res = await fetch("/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settings),
  });
  if (!res.ok) {
    throw new Error(`save settings failed: ${res.status}`);
  }
}

export async function getVaults(): Promise<VaultEntry[]> {
  const res = await fetch("/api/vaults");
  if (!res.ok) {
    throw new Error(`vaults failed: ${res.status}`);
  }
  return readJson<VaultEntry[]>(res, "get vaults");
}

export async function activateVault(index: number): Promise<boolean> {
  const res = await fetch(`/api/vaults/${index}/activate`, { method: "POST" });
  return res.ok;
}
