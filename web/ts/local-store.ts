/// IndexedDB-backed local store for offline resilience.
/// Caches session state and note content so the app survives server downtime.

const DB_NAME = "tansu";
const DB_VERSION = 1;

let db: IDBDatabase | null = null;

export async function openStore(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains("kv")) d.createObjectStore("kv");
      if (!d.objectStoreNames.contains("notes")) d.createObjectStore("notes");
      // Reserved for future offline write queue (note saves, deletes).
      if (!d.objectStoreNames.contains("queue"))
        d.createObjectStore("queue", { autoIncrement: true });
    };
    req.onsuccess = () => {
      db = req.result;
      resolve();
    };
    req.onerror = () => reject(req.error);
  });
}

export function closeStore(): void {
  if (db) {
    db.close();
    db = null;
  }
}

function tx(store: string, mode: IDBTransactionMode): IDBObjectStore {
  return db!.transaction(store, mode).objectStore(store);
}

function idbGet<T>(store: string, key: string): Promise<T | undefined> {
  if (!db) return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    const req = tx(store, "readonly").get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

function idbPut(store: string, key: string, value: unknown): Promise<void> {
  if (!db) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const req = tx(store, "readwrite").put(value, key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export function kvGet<T>(key: string): Promise<T | undefined> {
  return idbGet<T>("kv", key);
}

export function kvPut(key: string, value: unknown): Promise<void> {
  return idbPut("kv", key, value);
}

export interface CachedNote {
  content: string;
  mtime: number;
}

export function noteGet(path: string): Promise<CachedNote | undefined> {
  return idbGet<CachedNote>("notes", path);
}

export function notePut(path: string, content: string, mtime: number): Promise<void> {
  return idbPut("notes", path, { content, mtime } satisfies CachedNote);
}

export function noteDel(path: string): Promise<void> {
  if (!db) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const req = tx("notes", "readwrite").delete(path);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}
