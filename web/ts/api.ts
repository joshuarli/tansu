export interface Note {
  content: string;
  mtime: number;
}

export interface FieldScores {
  title: number;
  headings: number;
  tags: number;
  content: number;
}

export interface SearchResult {
  path: string;
  title: string;
  excerpt: string;
  score: number;
  field_scores: FieldScores;
}

export interface NoteEntry {
  path: string;
  title: string;
}

export interface FileSearchResult {
  path: string;
  title: string;
}

export interface RecentFileEntry {
  path: string;
  title: string;
  mtime: number;
}

export interface PinnedFileEntry {
  path: string;
  title: string;
}

type JsonObject = Record<string, unknown>;

function expectObject(value: unknown, ctx: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${ctx}: expected object`);
  }
  return value as JsonObject;
}

function expectString(value: unknown, ctx: string): string {
  if (typeof value !== "string") {
    throw new Error(`${ctx}: expected string`);
  }
  return value;
}

function expectNumber(value: unknown, ctx: string): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new Error(`${ctx}: expected number`);
  }
  return value;
}

function expectBoolean(value: unknown, ctx: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${ctx}: expected boolean`);
  }
  return value;
}

function expectStringArray(value: unknown, ctx: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${ctx}: expected string[]`);
  }
  return value.map((entry, index) => expectString(entry, `${ctx}[${index}]`));
}

function expectNumberArray(value: unknown, ctx: string): number[] {
  if (!Array.isArray(value)) {
    throw new Error(`${ctx}: expected number[]`);
  }
  return value.map((entry, index) => expectNumber(entry, `${ctx}[${index}]`));
}

function expectArray<T>(
  value: unknown,
  ctx: string,
  map: (entry: unknown, index: number) => T,
): T[] {
  if (!Array.isArray(value)) {
    throw new Error(`${ctx}: expected array`);
  }
  return value.map((entry, index) => map(entry, index));
}

async function readJson(res: Response, ctx: string): Promise<unknown> {
  try {
    return await res.json();
  } catch (error) {
    throw new Error(
      `${ctx}: invalid JSON${error instanceof Error && error.message ? ` (${error.message})` : ""}`,
    );
  }
}

function parseFieldScores(value: unknown, ctx: string): FieldScores {
  const obj = expectObject(value, ctx);
  return {
    title: expectNumber(obj["title"], `${ctx}.title`),
    headings: expectNumber(obj["headings"], `${ctx}.headings`),
    tags: expectNumber(obj["tags"], `${ctx}.tags`),
    content: expectNumber(obj["content"], `${ctx}.content`),
  };
}

function parseSearchResult(value: unknown, ctx: string): SearchResult {
  const obj = expectObject(value, ctx);
  return {
    path: expectString(obj["path"], `${ctx}.path`),
    title: expectString(obj["title"], `${ctx}.title`),
    excerpt: expectString(obj["excerpt"], `${ctx}.excerpt`),
    score: expectNumber(obj["score"], `${ctx}.score`),
    field_scores: parseFieldScores(obj["field_scores"], `${ctx}.field_scores`),
  };
}

function parseNote(value: unknown, ctx: string): Note {
  const obj = expectObject(value, ctx);
  return {
    content: expectString(obj["content"], `${ctx}.content`),
    mtime: expectNumber(obj["mtime"], `${ctx}.mtime`),
  };
}

function parseMtimeResult(value: unknown, ctx: string): { mtime: number } {
  const obj = expectObject(value, ctx);
  return { mtime: expectNumber(obj["mtime"], `${ctx}.mtime`) };
}

function parseUpdatedResult(value: unknown, ctx: string): { updated: string[] } {
  const obj = expectObject(value, ctx);
  return { updated: expectStringArray(obj["updated"], `${ctx}.updated`) };
}

function parseNoteEntry(value: unknown, ctx: string): NoteEntry {
  const obj = expectObject(value, ctx);
  return {
    path: expectString(obj["path"], `${ctx}.path`),
    title: expectString(obj["title"], `${ctx}.title`),
  };
}

function parseRecentFileEntry(value: unknown, ctx: string): RecentFileEntry {
  const obj = expectObject(value, ctx);
  return {
    path: expectString(obj["path"], `${ctx}.path`),
    title: expectString(obj["title"], `${ctx}.title`),
    mtime: expectNumber(obj["mtime"], `${ctx}.mtime`),
  };
}

function parsePinnedFileEntry(value: unknown, ctx: string): PinnedFileEntry {
  const obj = expectObject(value, ctx);
  return {
    path: expectString(obj["path"], `${ctx}.path`),
    title: expectString(obj["title"], `${ctx}.title`),
  };
}

function parseSaveResult(value: unknown, ctx: string): SaveResult {
  const obj = expectObject(value, ctx);
  const conflict = obj["conflict"];
  const content = obj["content"];
  return {
    mtime: expectNumber(obj["mtime"], `${ctx}.mtime`),
    ...(conflict === undefined ? {} : { conflict: expectBoolean(conflict, `${ctx}.conflict`) }),
    ...(content === undefined ? {} : { content: expectString(content, `${ctx}.content`) }),
  };
}

function parseSessionState(value: unknown, ctx: string): SessionState {
  const obj = expectObject(value, ctx);
  const tabs = obj["tabs"];
  const active = obj["active"];
  const closed = obj["closed"];
  const cursors = obj["cursors"];

  let parsedCursors: Record<string, number> | undefined;
  if (cursors !== undefined) {
    const cursorObj = expectObject(cursors, `${ctx}.cursors`);
    parsedCursors = Object.fromEntries(
      Object.entries(cursorObj).map(([path, offset]) => [
        path,
        expectNumber(offset, `${ctx}.cursors.${path}`),
      ]),
    );
  }

  return {
    ...(tabs === undefined ? {} : { tabs: expectStringArray(tabs, `${ctx}.tabs`) }),
    ...(active === undefined ? {} : { active: expectNumber(active, `${ctx}.active`) }),
    ...(closed === undefined ? {} : { closed: expectStringArray(closed, `${ctx}.closed`) }),
    ...(parsedCursors === undefined ? {} : { cursors: parsedCursors }),
  };
}

function parseSettings(value: unknown, ctx: string): Settings {
  const obj = expectObject(value, ctx);
  return {
    weight_title: expectNumber(obj["weight_title"], `${ctx}.weight_title`),
    weight_headings: expectNumber(obj["weight_headings"], `${ctx}.weight_headings`),
    weight_tags: expectNumber(obj["weight_tags"], `${ctx}.weight_tags`),
    weight_content: expectNumber(obj["weight_content"], `${ctx}.weight_content`),
    fuzzy_distance: expectNumber(obj["fuzzy_distance"], `${ctx}.fuzzy_distance`),
    recency_boost: expectNumber(obj["recency_boost"], `${ctx}.recency_boost`),
    result_limit: expectNumber(obj["result_limit"], `${ctx}.result_limit`),
    show_score_breakdown: expectBoolean(obj["show_score_breakdown"], `${ctx}.show_score_breakdown`),
    excluded_folders: expectStringArray(obj["excluded_folders"], `${ctx}.excluded_folders`),
  };
}

function parseAppStatus(value: unknown, ctx: string): AppStatus {
  const obj = expectObject(value, ctx);
  return {
    locked: expectBoolean(obj["locked"], `${ctx}.locked`),
    encrypted: expectBoolean(obj["encrypted"], `${ctx}.encrypted`),
    needs_setup: expectBoolean(obj["needs_setup"], `${ctx}.needs_setup`),
    prf_credential_ids: expectStringArray(obj["prf_credential_ids"], `${ctx}.prf_credential_ids`),
    prf_credential_names: expectStringArray(
      obj["prf_credential_names"],
      `${ctx}.prf_credential_names`,
    ),
  };
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
  return expectArray(await readJson(res, "search"), "search", (entry, index) =>
    parseSearchResult(entry, `search[${index}]`),
  );
}

export async function getNote(path: string): Promise<Note> {
  const res = await fetch(`/api/note?path=${encodeURIComponent(path)}`);
  if (!res.ok) {
    throw new Error(`get note failed: ${res.status}`);
  }
  return parseNote(await readJson(res, "get note"), "get note");
}

export interface SaveResult {
  mtime: number;
  conflict?: boolean;
  content?: string;
}

export async function saveNote(
  path: string,
  content: string,
  expectedMtime: number,
): Promise<SaveResult> {
  const res = await fetch(`/api/note?path=${encodeURIComponent(path)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, expected_mtime: expectedMtime }),
  });
  const data = await readJson(res, "save note");
  if (res.status === 409) {
    const parsed = parseSaveResult(data, "save note conflict");
    return { ...parsed, conflict: true };
  }
  if (!res.ok) {
    throw new Error(`save failed: ${res.status}`);
  }
  return parseMtimeResult(data, "save note");
}

// Unconditional overwrite — server treats expected_mtime=0 as "skip conflict check".
export function forceSaveNote(path: string, content: string): Promise<SaveResult> {
  return saveNote(path, content, 0);
}

export async function createNote(path: string): Promise<{ mtime: number }> {
  const res = await fetch(`/api/note?path=${encodeURIComponent(path)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: "" }),
  });
  if (!res.ok) {
    throw new Error(`create failed: ${res.status}`);
  }
  return parseMtimeResult(await readJson(res, "create note"), "create note");
}

export async function deleteNote(path: string): Promise<void> {
  const res = await fetch(`/api/note?path=${encodeURIComponent(path)}`, { method: "DELETE" });
  if (!res.ok) {
    throw new Error(`delete failed: ${res.status}`);
  }
}

export async function renameNote(oldPath: string, newPath: string): Promise<{ updated: string[] }> {
  const res = await fetch("/api/rename", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ old_path: oldPath, new_path: newPath }),
  });
  if (!res.ok) {
    throw new Error(`rename failed: ${res.status}`);
  }
  return parseUpdatedResult(await readJson(res, "rename note"), "rename note");
}

export async function listNotes(): Promise<NoteEntry[]> {
  const res = await fetch("/api/notes");
  if (!res.ok) {
    throw new Error(`list failed: ${res.status}`);
  }
  return expectArray(await readJson(res, "list notes"), "list notes", (entry, index) =>
    parseNoteEntry(entry, `list notes[${index}]`),
  );
}

export async function searchFileNames(q: string): Promise<FileSearchResult[]> {
  const res = await fetch(`/api/filesearch?q=${encodeURIComponent(q)}`);
  if (!res.ok) {
    throw new Error(`filesearch failed: ${res.status}`);
  }
  return expectArray(
    await readJson(res, "search file names"),
    "search file names",
    (entry, index) => parseNoteEntry(entry, `search file names[${index}]`),
  );
}

export async function getRecentFiles(): Promise<RecentFileEntry[]> {
  const res = await fetch("/api/recentfiles");
  if (!res.ok) {
    throw new Error(`recentfiles failed: ${res.status}`);
  }
  return expectArray(await readJson(res, "recent files"), "recent files", (entry, index) =>
    parseRecentFileEntry(entry, `recent files[${index}]`),
  );
}

export async function getPinnedFiles(): Promise<PinnedFileEntry[]> {
  const res = await fetch("/api/pinned");
  if (!res.ok) {
    throw new Error(`pinned failed: ${res.status}`);
  }
  return expectArray(await readJson(res, "pinned files"), "pinned files", (entry, index) =>
    parsePinnedFileEntry(entry, `pinned files[${index}]`),
  );
}

export async function pinFile(path: string): Promise<void> {
  const res = await fetch("/api/pin", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  if (!res.ok) {
    throw new Error(`pin failed: ${res.status}`);
  }
}

export async function unpinFile(path: string): Promise<void> {
  const res = await fetch("/api/pin", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
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
  return expectStringArray(await readJson(res, "backlinks"), "backlinks");
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
  const data = expectObject(await readJson(res, "upload image"), "upload image");
  return expectString(data["filename"], "upload image.filename");
}

export async function listRevisions(path: string): Promise<number[]> {
  const res = await fetch(`/api/revisions?path=${encodeURIComponent(path)}`);
  if (!res.ok) {
    throw new Error(`revisions failed: ${res.status}`);
  }
  return expectNumberArray(await readJson(res, "list revisions"), "list revisions");
}

export async function getRevision(path: string, ts: number): Promise<string> {
  const res = await fetch(`/api/revision?path=${encodeURIComponent(path)}&ts=${ts}`);
  if (!res.ok) {
    throw new Error(`revision failed: ${res.status}`);
  }
  const data = expectObject(await readJson(res, "get revision"), "get revision");
  return expectString(data["content"], "get revision.content");
}

export async function restoreRevision(path: string, ts: number): Promise<{ mtime: number }> {
  const res = await fetch(`/api/restore?path=${encodeURIComponent(path)}&ts=${ts}`, {
    method: "POST",
  });
  if (!res.ok) {
    throw new Error(`restore failed: ${res.status}`);
  }
  return parseMtimeResult(await readJson(res, "restore revision"), "restore revision");
}

export interface SessionState {
  tabs?: string[];
  active?: number;
  closed?: string[];
  cursors?: Record<string, number>;
}

export async function getState(): Promise<SessionState> {
  const res = await fetch("/api/state");
  if (!res.ok) {
    throw new Error(`state failed: ${res.status}`);
  }
  return parseSessionState(await readJson(res, "get state"), "get state");
}

export async function saveState(state: SessionState): Promise<void> {
  await fetch("/api/state", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(state),
  });
}

export interface Settings {
  weight_title: number;
  weight_headings: number;
  weight_tags: number;
  weight_content: number;
  fuzzy_distance: number;
  recency_boost: number;
  result_limit: number;
  show_score_breakdown: boolean;
  excluded_folders: string[];
}

export interface AppStatus {
  locked: boolean;
  encrypted: boolean;
  needs_setup: boolean;
  prf_credential_ids: string[];
  prf_credential_names: string[];
}

export async function getStatus(): Promise<AppStatus> {
  const res = await fetch("/api/status");
  if (!res.ok) {
    throw new Error(`status failed: ${res.status}`);
  }
  return parseAppStatus(await readJson(res, "get status"), "get status");
}

export async function unlockWithRecoveryKey(recoveryKey: string): Promise<boolean> {
  const res = await fetch("/api/unlock", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ recovery_key: recoveryKey }),
  });
  return res.ok;
}

export async function unlockWithPrf(prfKeyB64: string): Promise<boolean> {
  const res = await fetch("/api/unlock", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prf_key: prfKeyB64 }),
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
  const res = await fetch("/api/prf/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ credential_id: credentialId, prf_key: prfKeyB64, name }),
  });
  return res.ok;
}

export async function removePrf(credentialId: string): Promise<boolean> {
  const res = await fetch("/api/prf/remove", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ credential_id: credentialId }),
  });
  return res.ok;
}

export async function getSettings(): Promise<Settings> {
  const res = await fetch("/api/settings");
  if (!res.ok) {
    throw new Error(`settings failed: ${res.status}`);
  }
  return parseSettings(await readJson(res, "get settings"), "get settings");
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

export interface VaultEntry {
  index: number;
  name: string;
  active: boolean;
  encrypted: boolean;
  locked: boolean;
}

export async function getVaults(): Promise<VaultEntry[]> {
  const res = await fetch("/api/vaults");
  if (!res.ok) {
    throw new Error(`vaults failed: ${res.status}`);
  }
  const arr = expectArray(await readJson(res, "get vaults"), "get vaults", (v, i) => {
    const obj = expectObject(v, `vaults[${i}]`);
    return {
      index: expectNumber(obj["index"], `vaults[${i}].index`),
      name: expectString(obj["name"], `vaults[${i}].name`),
      active: obj["active"] === true,
      encrypted: obj["encrypted"] === true,
      locked: obj["locked"] === true,
    } satisfies VaultEntry;
  });
  return arr;
}

export async function activateVault(index: number): Promise<boolean> {
  const res = await fetch(`/api/vaults/${index}/activate`, { method: "POST" });
  return res.ok;
}
