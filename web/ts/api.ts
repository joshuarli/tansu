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
  TagListResponse,
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
  TagListResponse,
  UnlockRequest,
  VaultEntry,
};

export type Note = NoteResponse;
export type SearchResult = SearchHit;

export class ApiError extends Error {
  readonly status: number;
  readonly context: string;
  readonly body: string | undefined;

  constructor(context: string, status: number, body?: string) {
    super(`${context} failed: ${status}`);
    this.name = "ApiError";
    this.context = context;
    this.status = status;
    this.body = body;
  }
}

function apiPath(path: string, params?: Record<string, string | number | undefined>): string {
  if (!params) {
    return path;
  }
  const query = Object.entries(params)
    .filter((entry): entry is [string, string | number] => entry[1] !== undefined)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join("&");
  return query ? `${path}?${query}` : path;
}

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

async function readErrorBody(res: Response): Promise<string | undefined> {
  try {
    const body = await res.text();
    return body || undefined;
  } catch {
    return undefined;
  }
}

async function requestJson<T>(
  url: string,
  ctx: string,
  init?: RequestInit,
  okStatuses: readonly number[] = [],
): Promise<T> {
  return (await requestJsonWithStatus<T>(url, ctx, init, okStatuses)).data;
}

async function requestJsonWithStatus<T>(
  url: string,
  ctx: string,
  init?: RequestInit,
  okStatuses: readonly number[] = [],
): Promise<{ data: T; status: number }> {
  const res = await fetch(url, init);
  if (!res.ok && !okStatuses.includes(res.status)) {
    throw new ApiError(ctx, res.status, await readErrorBody(res));
  }
  return { data: await readJson<T>(res, ctx), status: res.status };
}

async function requestVoid(url: string, ctx: string, init?: RequestInit): Promise<void> {
  const res = await fetch(url, init);
  if (!res.ok) {
    throw new ApiError(ctx, res.status, await readErrorBody(res));
  }
}

export async function searchNotes(q: string, path?: string): Promise<SearchResult[]> {
  const results = await requestJson<SearchResult[]>(apiPath("/api/search", { q, path }), "search");
  return results.map((result) => ({ ...result, tags: result.tags ?? [] }));
}

export async function getNote(path: string): Promise<Note> {
  const note = await requestJson<Note>(apiPath("/api/note", { path }), "get note");
  return { ...note, tags: note.tags ?? [] };
}

export async function saveNote(
  path: string,
  content: string,
  expectedMtime: number,
): Promise<SaveResult> {
  const { data, status } = await requestJsonWithStatus<SaveResult>(
    apiPath("/api/note", { path }),
    "save note",
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, expected_mtime: expectedMtime } satisfies PutNoteRequest),
    },
    [409],
  );
  if (status === 409) {
    return { ...data, conflict: true };
  }
  return data;
}

export async function listTags(path?: string): Promise<string[]> {
  const data = await requestJson<TagListResponse>(apiPath("/api/tags", { path }), "list tags");
  return data.tags;
}

// Unconditional overwrite — server treats expected_mtime=0 as "skip conflict check".
export function forceSaveNote(path: string, content: string): Promise<SaveResult> {
  return saveNote(path, content, 0);
}

export async function createNote(path: string, content = ""): Promise<SaveResult> {
  return requestJson<SaveResult>(apiPath("/api/note", { path }), "create note", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content } satisfies CreateNoteRequest),
  });
}

export async function deleteNote(path: string): Promise<void> {
  await requestVoid(apiPath("/api/note", { path }), "delete", { method: "DELETE" });
}

export async function renameNote(oldPath: string, newPath: string): Promise<RenameResponse> {
  return requestJson<RenameResponse>("/api/rename", "rename", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ old_path: oldPath, new_path: newPath } satisfies RenameRequest),
  });
}

export async function listNotes(): Promise<NoteEntry[]> {
  const notes = await requestJson<NoteEntry[]>("/api/notes", "list");
  return notes.map((note) => ({ ...note, tags: note.tags ?? [] }));
}

export async function searchFileNames(q: string): Promise<FileSearchResult[]> {
  return requestJson<FileSearchResult[]>(apiPath("/api/filesearch", { q }), "filesearch");
}

export async function getRecentFiles(): Promise<RecentFileEntry[]> {
  return requestJson<RecentFileEntry[]>("/api/recentfiles", "recentfiles");
}

export async function getPinnedFiles(): Promise<PinnedFileEntry[]> {
  return requestJson<PinnedFileEntry[]>("/api/pinned", "pinned");
}

export async function pinFile(path: string): Promise<void> {
  await requestVoid("/api/pin", "pin", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path } satisfies PinRequest),
  });
}

export async function unpinFile(path: string): Promise<void> {
  await requestVoid("/api/pin", "unpin", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path } satisfies PinRequest),
  });
}

export async function getBacklinks(path: string): Promise<string[]> {
  return requestJson<string[]>(apiPath("/api/backlinks", { path }), "backlinks");
}

export async function uploadImage(blob: Blob, filename: string): Promise<string> {
  const data = await requestJson<FilenameResponse>("/api/image", "upload", {
    method: "POST",
    headers: { "X-Filename": filename },
    body: blob,
  });
  return data.filename;
}

export async function listRevisions(path: string): Promise<number[]> {
  return requestJson<number[]>(apiPath("/api/revisions", { path }), "revisions");
}

export async function getRevision(path: string, ts: number): Promise<string> {
  const data = await requestJson<ContentResponse>(
    apiPath("/api/revision", { path, ts }),
    "revision",
  );
  return data.content;
}

export async function restoreRevision(path: string, ts: number): Promise<SaveResult> {
  return requestJson<SaveResult>(apiPath("/api/restore", { path, ts }), "restore", {
    method: "POST",
  });
}

export async function getState(): Promise<SessionState> {
  return requestJson<SessionState>("/api/state", "state");
}

export async function saveState(state: SessionState): Promise<void> {
  await requestVoid("/api/state", "save state", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(state),
  });
}

export async function getStatus(): Promise<AppStatus> {
  return requestJson<AppStatus>("/api/status", "status");
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
  return requestJson<Settings>("/api/settings", "settings");
}

export async function saveSettings(settings: Settings): Promise<void> {
  await requestVoid("/api/settings", "save settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settings),
  });
}

export async function getVaults(): Promise<VaultEntry[]> {
  return requestJson<VaultEntry[]>("/api/vaults", "vaults");
}

export async function activateVault(index: number): Promise<boolean> {
  const res = await fetch(`/api/vaults/${index}/activate`, { method: "POST" });
  return res.ok;
}
