export interface Note {
  content: string;
  mtime: number;
}

export interface SearchResult {
  path: string;
  title: string;
  excerpt: string;
  score: number;
}

export interface NoteEntry {
  path: string;
  title: string;
}

export async function searchNotes(q: string): Promise<SearchResult[]> {
  const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
  if (!res.ok) throw new Error(`search failed: ${res.status}`);
  return res.json() as Promise<SearchResult[]>;
}

export async function getNote(path: string): Promise<Note> {
  const res = await fetch(`/api/note?path=${encodeURIComponent(path)}`);
  if (!res.ok) throw new Error(`get note failed: ${res.status}`);
  return res.json() as Promise<Note>;
}

export interface SaveResult {
  mtime: number;
  conflict?: boolean;
  content?: string;
}

export async function saveNote(path: string, content: string, expectedMtime: number): Promise<SaveResult> {
  const res = await fetch(`/api/note?path=${encodeURIComponent(path)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, expected_mtime: expectedMtime }),
  });
  const data = await res.json() as Record<string, unknown>;
  if (res.status === 409) {
    return { mtime: data['mtime'] as number, conflict: true, content: data['content'] as string };
  }
  if (!res.ok) throw new Error(`save failed: ${res.status}`);
  return { mtime: data['mtime'] as number };
}

export async function createNote(path: string): Promise<{ mtime: number }> {
  const res = await fetch(`/api/note?path=${encodeURIComponent(path)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: '' }),
  });
  if (!res.ok) throw new Error(`create failed: ${res.status}`);
  return res.json() as Promise<{ mtime: number }>;
}

export async function deleteNote(path: string): Promise<void> {
  const res = await fetch(`/api/note?path=${encodeURIComponent(path)}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`delete failed: ${res.status}`);
}

export async function renameNote(oldPath: string, newPath: string): Promise<{ updated: string[] }> {
  const res = await fetch('/api/rename', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ old_path: oldPath, new_path: newPath }),
  });
  if (!res.ok) throw new Error(`rename failed: ${res.status}`);
  return res.json() as Promise<{ updated: string[] }>;
}

export async function listNotes(): Promise<NoteEntry[]> {
  const res = await fetch('/api/notes');
  if (!res.ok) throw new Error(`list failed: ${res.status}`);
  return res.json() as Promise<NoteEntry[]>;
}

export async function getBacklinks(path: string): Promise<string[]> {
  const res = await fetch(`/api/backlinks?path=${encodeURIComponent(path)}`);
  if (!res.ok) throw new Error(`backlinks failed: ${res.status}`);
  return res.json() as Promise<string[]>;
}

export async function uploadImage(blob: Blob, filename: string): Promise<string> {
  const res = await fetch('/api/image', {
    method: 'POST',
    headers: { 'X-Filename': filename },
    body: blob,
  });
  if (!res.ok) throw new Error(`upload failed: ${res.status}`);
  const data = await res.json() as { filename: string };
  return data.filename;
}

export async function listRevisions(path: string): Promise<number[]> {
  const res = await fetch(`/api/revisions?path=${encodeURIComponent(path)}`);
  if (!res.ok) throw new Error(`revisions failed: ${res.status}`);
  return res.json() as Promise<number[]>;
}

export async function getRevision(path: string, ts: number): Promise<string> {
  const res = await fetch(`/api/revision?path=${encodeURIComponent(path)}&ts=${ts}`);
  if (!res.ok) throw new Error(`revision failed: ${res.status}`);
  const data = await res.json() as { content: string };
  return data.content;
}

export async function restoreRevision(path: string, ts: number): Promise<{ mtime: number }> {
  const res = await fetch(`/api/restore?path=${encodeURIComponent(path)}&ts=${ts}`, { method: 'POST' });
  if (!res.ok) throw new Error(`restore failed: ${res.status}`);
  return res.json() as Promise<{ mtime: number }>;
}

export interface SessionState {
  tabs?: string[];
  active?: number;
}

export async function getState(): Promise<SessionState> {
  const res = await fetch('/api/state');
  if (!res.ok) return {};
  return res.json() as Promise<SessionState>;
}

export async function saveState(state: SessionState): Promise<void> {
  await fetch('/api/state', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(state),
  });
}
