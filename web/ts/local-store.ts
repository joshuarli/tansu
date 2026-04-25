/// IndexedDB-backed local store for offline resilience.
/// Caches session state and note content so the app survives server downtime.

const DB_NAME = "tansu";
const DB_VERSION = 2;

let db: IDBDatabase | null = null;

export async function openStore(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains("kv")) {
        d.createObjectStore("kv");
      }
      if (!d.objectStoreNames.contains("notes")) {
        d.createObjectStore("notes");
      }
      // Reserved for future offline write queue (note saves, deletes).
      if (!d.objectStoreNames.contains("queue")) {
        d.createObjectStore("queue", { autoIncrement: true });
      }
    };
    req.onsuccess = () => {
      db = req.result;
      resolve();
    };
    /* c8 ignore start */
    req.onerror = () => reject(req.error);
    /* c8 ignore stop */
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
  if (!db) {
    return Promise.resolve() as Promise<T | undefined>;
  }
  return new Promise((resolve, reject) => {
    const req = tx(store, "readonly").get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    /* c8 ignore start */
    req.onerror = () => reject(req.error);
    /* c8 ignore stop */
  });
}

function idbPut(store: string, key: string, value: unknown): Promise<void> {
  if (!db) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const req = tx(store, "readwrite").put(value, key);
    req.onsuccess = () => resolve();
    /* c8 ignore start */
    req.onerror = () => reject(req.error);
    /* c8 ignore stop */
  });
}

export function kvGet<T>(key: string): Promise<T | undefined> {
  return idbGet<T>("kv", key);
}

export function kvPut(key: string, value: unknown): Promise<void> {
  return idbPut("kv", key, value);
}

type CachedNote = {
  content: string;
  mtime: number;
  tags: string[];
};

export async function noteGet(path: string): Promise<CachedNote | undefined> {
  const note = await idbGet<Partial<CachedNote>>("notes", path);
  if (!note) {
    return undefined;
  }
  return {
    content: note.content ?? "",
    mtime: note.mtime ?? 0,
    tags: note.tags ?? [],
  };
}

export function notePut(
  path: string,
  content: string,
  mtime: number,
  tags: string[],
): Promise<void> {
  return idbPut("notes", path, { content, mtime, tags } satisfies CachedNote);
}

export function noteDel(path: string): Promise<void> {
  if (!db) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const req = tx("notes", "readwrite").delete(path);
    req.onsuccess = () => resolve();
    /* c8 ignore start */
    req.onerror = () => reject(req.error);
    /* c8 ignore stop */
  });
}
