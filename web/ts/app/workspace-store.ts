import type { SessionState, V2NoteDocument, V2NoteMeta } from "../types.generated.ts";
import type { DocumentIdentity, ServerIdentity, WorkspaceId } from "./identity.ts";

const DATABASE_NAME = "tansu2-client-state-v2";
const DATABASE_VERSION = 1;
const CLEAN_NOTES = "cleanNotes";
const WORKSPACES = "workspaces";
const DRAFTS = "draftJournal";
const BY_NOTE_IDENTITY = "by-note-identity";
const BY_CACHE_TIME = "by-cache-time";
const MAX_CLEAN_NOTES = 300;

export type CachedNoteBody = {
  formatVersion: 2;
  serverInstanceId: string;
  vaultId: string;
  noteId: string;
  sourceHash: string;
  content: string;
  cachedAtMs: number;
};

export type WorkspaceTab = {
  noteId: string;
  title: string;
  path: string;
  selection: { anchor: number; head: number } | null;
  scrollTop: number;
  mode: "live" | "source";
};

export type WorkspaceState = {
  formatVersion: 1;
  serverInstanceId: string;
  vaultId: string;
  workspaceId: string;
  tabs: WorkspaceTab[];
  activeNoteId: string | null;
  closedTabs: WorkspaceTab[];
  pinnedNoteIds: string[];
  recentNoteIds: string[];
  searchHistory: string[];
  legacySessionImported: boolean;
  savedAtMs: number;
};

export type DraftJournalRecord = {
  formatVersion: 1;
  serverInstanceId: string;
  vaultId: string;
  workspaceId: string;
  noteId: string;
  baseRevision: number;
  baseSourceHash: string;
  baseDiskHash: string;
  localRevision: number;
  mutationId: string;
  source: string;
  titleDraft: string | null;
  selection: { anchor: number; head: number } | null;
  checkpointedAtMs: number;
};

export type ClientStorageFailureKind = "unavailable" | "quota" | "transaction" | "corrupt";

export class ClientStorageFailureError extends Error {
  readonly kind: ClientStorageFailureKind;

  constructor(kind: ClientStorageFailureKind, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ClientStorageFailureError";
    this.kind = kind;
  }
}

export class DraftJournal {
  private readonly pending = new Map<string, DraftJournalRecord>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly writes = new Map<string, Promise<boolean>>();
  private readonly failureHandlers = new Map<string, (error: unknown) => void>();
  private readonly detachListeners = new Set<() => void>();

  constructor(
    private readonly onFailure: (error: unknown) => void,
    private readonly debounceMs = 200,
    private readonly write: (record: DraftJournalRecord) => Promise<boolean> = writeDraftCheckpoint,
    private readonly clear: typeof clearDraftCheckpoint = clearDraftCheckpoint,
  ) {}

  schedule(record: DraftJournalRecord, onFailure = this.onFailure): undefined {
    const valid = decodeDraftJournalRecord(record);
    const key = draftKey(valid);
    this.pending.set(key, valid);
    this.failureHandlers.set(key, onFailure);
    const oldTimer = this.timers.get(key);
    if (oldTimer !== undefined) {
      clearTimeout(oldTimer);
    }
    this.timers.set(key, setTimeout(() => {
      this.timers.delete(key);
      void this.flushKey(key).catch(() => undefined);
    }, this.debounceMs));
    return undefined;
  }

  checkpoint(record: DraftJournalRecord, onFailure = this.onFailure): Promise<boolean> {
    const valid = decodeDraftJournalRecord(record);
    const key = draftKey(valid);
    this.failureHandlers.set(key, onFailure);
    const timer = this.timers.get(key);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timers.delete(key);
    }
    this.pending.set(key, valid);
    return this.flushKey(key);
  }

  async flushAll(): Promise<void> {
    const keys = new Set([...this.pending.keys(), ...this.timers.keys(), ...this.writes.keys()]);
    const tasks = [...keys].map((key) => {
      const timer = this.timers.get(key);
      if (timer !== undefined) {
        clearTimeout(timer);
        this.timers.delete(key);
      }
      return this.flushKey(key);
    });
    const results = await Promise.allSettled(tasks);
    const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failed !== undefined) {
      throw failed.reason;
    }
  }

  async clearCheckpoint(
    identity: ServerIdentity,
    workspace: WorkspaceId,
    noteId: string,
    acceptedLocalRevision: number,
    acceptedMutationId: string,
  ): Promise<boolean> {
    const key = draftIdentityKey(identity, workspace, noteId);
    const pending = this.pending.get(key);
    if (pending !== undefined) {
      if (pending.localRevision !== acceptedLocalRevision || pending.mutationId !== acceptedMutationId) {
        return false;
      }
      const timer = this.timers.get(key);
      if (timer !== undefined) {
        clearTimeout(timer);
        this.timers.delete(key);
      }
      this.pending.delete(key);
    }
    const previous = this.writes.get(key);
    const next = (previous ?? Promise.resolve(false)).then(() =>
      this.clear(identity, workspace, noteId, acceptedLocalRevision, acceptedMutationId)
    );
    this.writes.set(key, next);
    try {
      return await next;
    } finally {
      if (this.writes.get(key) === next) {
        this.writes.delete(key);
        if (!this.pending.has(key)) {
          this.failureHandlers.delete(key);
        }
      }
    }
  }

  attachVisibilityFlush(documentTarget: Document, windowTarget: Window): () => void {
    const flushWhenHidden = () => {
      if (documentTarget.visibilityState === "hidden") {
        void this.flushAll().catch(this.onFailure);
      }
    };
    const flushOnPageHide = () => void this.flushAll().catch(this.onFailure);
    documentTarget.addEventListener("visibilitychange", flushWhenHidden);
    windowTarget.addEventListener("pagehide", flushOnPageHide);
    const detach = () => {
      documentTarget.removeEventListener("visibilitychange", flushWhenHidden);
      windowTarget.removeEventListener("pagehide", flushOnPageHide);
      this.detachListeners.delete(detach);
    };
    this.detachListeners.add(detach);
    return detach;
  }

  async dispose(): Promise<void> {
    for (const detach of [...this.detachListeners]) {
      detach();
    }
    await this.flushAll();
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }

  private flushKey(key: string): Promise<boolean> {
    const record = this.pending.get(key);
    const previous = this.writes.get(key);
    if (record === undefined) {
      return previous ?? Promise.resolve(false);
    }
    this.pending.delete(key);
    const next = (previous ?? Promise.resolve(false))
      .catch(() => false)
      .then(async () => {
        const written = await this.write(record);
        if (!written) {
          throw new ClientStorageFailureError("transaction", "A newer draft checkpoint is already stored");
        }
        return true;
      })
      .catch((error: unknown) => {
        const failureHandler = this.failureHandlers.get(key);
        if (failureHandler !== undefined) {
          failureHandler(error);
        }
        if (failureHandler !== this.onFailure) {
          this.onFailure(error);
        }
        throw error;
      });
    this.writes.set(key, next);
    void next.finally(() => {
      if (this.writes.get(key) === next) {
        this.writes.delete(key);
        if (!this.pending.has(key)) {
          this.failureHandlers.delete(key);
        }
      }
    }).catch(() => undefined);
    return next;
  }
}

export function createDraftCheckpointWriter(
  journal: DraftJournal,
): (
  record: DraftJournalRecord,
  urgency: "typing" | "structural",
  onFailure: (error: unknown) => void,
) => undefined | Promise<boolean> {
  return (record, urgency, onFailure) => urgency === "typing"
    ? journal.schedule(record, onFailure)
    : journal.checkpoint(record, onFailure);
}

export function createDraftCheckpointClearer(
  journal: DraftJournal,
  workspace: WorkspaceId,
): (
  identity: DocumentIdentity,
  acceptedLocalRevision: number,
  acceptedMutationId: string,
) => Promise<boolean> {
  return (identity, acceptedLocalRevision, acceptedMutationId) =>
    journal.clearCheckpoint(
      identity,
      workspace,
      identity.noteId,
      acceptedLocalRevision,
      acceptedMutationId,
    );
}

export async function getCachedNoteBody(
  identity: DocumentIdentity,
  meta: Pick<V2NoteMeta, "noteId" | "sourceHash">,
): Promise<CachedNoteBody | null> {
  if (meta.noteId !== identity.noteId) {
    throw new ClientStorageFailureError("corrupt", "Cache lookup note identity does not match its key");
  }
  const db = await openDatabase();
  try {
    const transaction = db.transaction(CLEAN_NOTES, "readonly");
    const done = transactionDone(transaction);
    const request = transaction.objectStore(CLEAN_NOTES).get([
      2,
      identity.serverInstanceId,
      identity.vaultId,
      identity.noteId,
      meta.sourceHash,
    ]) as IDBRequest<unknown>;
    const [value] = await Promise.all([requestResult(request), done]);
    if (value === undefined) {
      return null;
    }
    const cached = decodeCachedNoteBody(value);
    if (cached.serverInstanceId !== identity.serverInstanceId || cached.vaultId !== identity.vaultId ||
      cached.noteId !== identity.noteId || cached.sourceHash !== meta.sourceHash) {
      throw corrupt("Cached note identity does not match its storage key");
    }
    return cached;
  } catch (error) {
    throw storageFailure(error);
  } finally {
    db.close();
  }
}

export async function cacheNoteBody(identity: DocumentIdentity, document: V2NoteDocument): Promise<void> {
  const note = decodeV2NoteDocument(document);
  if (note.meta.noteId !== identity.noteId) {
    throw new ClientStorageFailureError("corrupt", "Cache write note identity does not match its key");
  }
  const entry: CachedNoteBody = {
    formatVersion: 2,
    serverInstanceId: identity.serverInstanceId,
    vaultId: identity.vaultId,
    noteId: identity.noteId,
    sourceHash: note.meta.sourceHash,
    content: note.content,
    cachedAtMs: Date.now(),
  };
  const db = await openDatabase();
  try {
    const transaction = db.transaction(CLEAN_NOTES, "readwrite");
    const store = transaction.objectStore(CLEAN_NOTES);
    store.put(entry);
    deleteOtherHashes(store, identity, entry.sourceHash);
    pruneCleanCache(store);
    await transactionDone(transaction);
  } catch (error) {
    throw storageFailure(error);
  } finally {
    db.close();
  }
}

export async function deleteCachedNoteBodies(identity: DocumentIdentity): Promise<void> {
  const db = await openDatabase();
  try {
    const transaction = db.transaction(CLEAN_NOTES, "readwrite");
    deleteOtherHashes(transaction.objectStore(CLEAN_NOTES), identity);
    await transactionDone(transaction);
  } catch (error) {
    throw storageFailure(error);
  } finally {
    db.close();
  }
}

export async function getWorkspaceState(
  identity: ServerIdentity,
  workspace: WorkspaceId,
): Promise<WorkspaceState | null> {
  const db = await openDatabase();
  try {
    const transaction = db.transaction(WORKSPACES, "readonly");
    const done = transactionDone(transaction);
    const request = transaction.objectStore(WORKSPACES).get(workspaceKey(identity, workspace)) as IDBRequest<unknown>;
    const [value] = await Promise.all([requestResult(request), done]);
    if (value === undefined) {
      return null;
    }
    const state = decodeWorkspaceState(value);
    assertWorkspaceKey(state, identity, workspace);
    return state;
  } catch (error) {
    throw storageFailure(error);
  } finally {
    db.close();
  }
}

export async function saveWorkspaceState(state: WorkspaceState): Promise<void> {
  const valid = decodeWorkspaceState(state);
  const db = await openDatabase();
  try {
    const transaction = db.transaction(WORKSPACES, "readwrite");
    transaction.objectStore(WORKSPACES).put({ ...valid, savedAtMs: Date.now() });
    await transactionDone(transaction);
  } catch (error) {
    throw storageFailure(error);
  } finally {
    db.close();
  }
}

export async function importLegacySessionOnce(
  identity: ServerIdentity,
  workspace: WorkspaceId,
  session: SessionState,
): Promise<WorkspaceState> {
  const legacy = decodeLegacySession(session);
  const db = await openDatabase();
  try {
    const transaction = db.transaction(WORKSPACES, "readwrite");
    const done = transactionDone(transaction);
    const store = transaction.objectStore(WORKSPACES);
    const key = workspaceKey(identity, workspace);
    const raw = await requestResult(store.get(key) as IDBRequest<unknown>);
    const previous = raw === undefined ? null : decodeWorkspaceState(raw);
    if (previous?.legacySessionImported) {
      await done;
      assertWorkspaceKey(previous, identity, workspace);
      return previous;
    }
    const empty = emptyWorkspace(identity, workspace);
    const imported = decodeWorkspaceState({
      ...(previous ?? empty),
      tabs: previous?.tabs ?? legacy.openTabs.map(workspaceTabFromLegacy),
      activeNoteId: previous?.activeNoteId ?? legacy.activeNoteId,
      closedTabs: previous?.closedTabs ?? legacy.closedTabs.map(workspaceTabFromLegacy),
      legacySessionImported: true,
    });
    store.put({ ...imported, savedAtMs: Date.now() });
    await done;
    return imported;
  } catch (error) {
    throw storageFailure(error);
  } finally {
    db.close();
  }
}

export async function writeDraftCheckpoint(record: DraftJournalRecord): Promise<boolean> {
  const valid = decodeDraftJournalRecord(record);
  const db = await openDatabase();
  try {
    const transaction = db.transaction(DRAFTS, "readwrite");
    const done = transactionDone(transaction);
    const store = transaction.objectStore(DRAFTS);
    const key = draftKeyTuple(valid);
    const raw = await requestResult(store.get(key) as IDBRequest<unknown>);
    if (raw !== undefined && decodeDraftJournalRecord(raw).localRevision > valid.localRevision) {
      await done;
      return false;
    }
    store.put(valid);
    await done;
    return true;
  } catch (error) {
    throw storageFailure(error);
  } finally {
    db.close();
  }
}

export async function getDraftCheckpoint(
  identity: ServerIdentity,
  workspace: WorkspaceId,
  noteId: string,
): Promise<DraftJournalRecord | null> {
  const db = await openDatabase();
  try {
    const transaction = db.transaction(DRAFTS, "readonly");
    const done = transactionDone(transaction);
    const request = transaction.objectStore(DRAFTS).get([
      1,
      identity.serverInstanceId,
      identity.vaultId,
      workspace,
      noteId,
    ]) as IDBRequest<unknown>;
    const [value] = await Promise.all([requestResult(request), done]);
    if (value === undefined) {
      return null;
    }
    const record = decodeDraftJournalRecord(value);
    if (record.serverInstanceId !== identity.serverInstanceId || record.vaultId !== identity.vaultId ||
      record.workspaceId !== workspace || record.noteId !== noteId) {
      throw corrupt("Draft identity does not match its storage key");
    }
    return record;
  } catch (error) {
    throw storageFailure(error);
  } finally {
    db.close();
  }
}

export async function clearDraftCheckpoint(
  identity: ServerIdentity,
  workspace: WorkspaceId,
  noteId: string,
  acceptedLocalRevision: number,
  acceptedMutationId: string,
): Promise<boolean> {
  const db = await openDatabase();
  try {
    const transaction = db.transaction(DRAFTS, "readwrite");
    const done = transactionDone(transaction);
    const store = transaction.objectStore(DRAFTS);
    const key = [1, identity.serverInstanceId, identity.vaultId, workspace, noteId];
    const raw = await requestResult(store.get(key) as IDBRequest<unknown>);
    if (raw === undefined) {
      await done;
      return false;
    }
    const record = decodeDraftJournalRecord(raw);
    if (record.serverInstanceId !== identity.serverInstanceId || record.vaultId !== identity.vaultId ||
      record.workspaceId !== workspace || record.noteId !== noteId) {
      throw corrupt("Draft identity does not match its storage key");
    }
    if (record.localRevision !== acceptedLocalRevision || record.mutationId !== acceptedMutationId) {
      await done;
      return false;
    }
    store.delete(key);
    await done;
    return true;
  } catch (error) {
    throw storageFailure(error);
  } finally {
    db.close();
  }
}

export function createWorkspaceId(storage?: Storage): WorkspaceId {
  try {
    const target = storage ?? globalThis.localStorage;
    const key = "tansu2.workspace.v1";
    const existing = target.getItem(key);
    if (existing !== null) {
      return identityString(existing, "workspaceId") as WorkspaceId;
    }
    const value = globalThis.crypto?.randomUUID();
    if (value === undefined) {
      throw new ClientStorageFailureError("unavailable", "Secure random workspace identity is unavailable");
    }
    target.setItem(key, value);
    return identityString(value, "workspaceId") as WorkspaceId;
  } catch (error) {
    throw storageFailure(error);
  }
}

export function decodeWorkspaceState(value: unknown): WorkspaceState {
  const body = object(value, "workspace");
  version(body["formatVersion"], 1, "workspace");
  return {
    formatVersion: 1,
    serverInstanceId: identityString(body["serverInstanceId"], "serverInstanceId"),
    vaultId: identityString(body["vaultId"], "vaultId"),
    workspaceId: identityString(body["workspaceId"], "workspaceId"),
    tabs: list(body["tabs"], "tabs", 500).map(decodeWorkspaceTab),
    activeNoteId: body["activeNoteId"] === null ? null : identityString(body["activeNoteId"], "activeNoteId"),
    closedTabs: list(body["closedTabs"], "closedTabs", 500).map(decodeWorkspaceTab),
    pinnedNoteIds: list(body["pinnedNoteIds"], "pinnedNoteIds", 500).map((id) => identityString(id, "pinned note id")),
    recentNoteIds: list(body["recentNoteIds"], "recentNoteIds", 500).map((id) => identityString(id, "recent note id")),
    searchHistory: list(body["searchHistory"], "searchHistory", 100).map((query) => text(query, "search query")),
    legacySessionImported: bool(body["legacySessionImported"], "legacySessionImported"),
    savedAtMs: safeInteger(body["savedAtMs"], "savedAtMs"),
  };
}

export function decodeDraftJournalRecord(value: unknown): DraftJournalRecord {
  const body = object(value, "draft journal record");
  version(body["formatVersion"], 1, "draft journal");
  const source = text(body["source"], "source");
  return {
    formatVersion: 1,
    serverInstanceId: identityString(body["serverInstanceId"], "serverInstanceId"),
    vaultId: identityString(body["vaultId"], "vaultId"),
    workspaceId: identityString(body["workspaceId"], "workspaceId"),
    noteId: identityString(body["noteId"], "noteId"),
    baseRevision: safeInteger(body["baseRevision"], "baseRevision"),
    baseSourceHash: sourceHash(body["baseSourceHash"], "baseSourceHash", "sha256-v2:"),
    baseDiskHash: sourceHash(body["baseDiskHash"], "baseDiskHash", "sha256:"),
    localRevision: safeInteger(body["localRevision"], "localRevision"),
    mutationId: boundedMutationId(body["mutationId"]),
    source,
    titleDraft: body["titleDraft"] === null ? null : text(body["titleDraft"], "titleDraft"),
    selection: body["selection"] === null ? null : selection(body["selection"], source.length),
    checkpointedAtMs: safeInteger(body["checkpointedAtMs"], "checkpointedAtMs"),
  };
}

export function decodeCachedNoteBody(value: unknown): CachedNoteBody {
  const body = object(value, "cached note");
  version(body["formatVersion"], 2, "cached note");
  return {
    formatVersion: 2,
    serverInstanceId: identityString(body["serverInstanceId"], "serverInstanceId"),
    vaultId: identityString(body["vaultId"], "vaultId"),
    noteId: identityString(body["noteId"], "noteId"),
    sourceHash: sourceHash(body["sourceHash"], "sourceHash", "sha256-v2:"),
    content: text(body["content"], "content"),
    cachedAtMs: safeInteger(body["cachedAtMs"], "cachedAtMs"),
  };
}

export function workspaceTabFromLegacy(tab: SessionState["openTabs"][number]): WorkspaceTab {
  return {
    noteId: identityString(tab.noteId, "noteId"),
    title: tab.title,
    path: tab.path,
    selection: tab.cursorOffset === null ? null : { anchor: tab.cursorOffset, head: tab.cursorOffset },
    scrollTop: 0,
    mode: tab.sourceMode ? "source" : "live",
  };
}

function decodeV2NoteDocument(value: V2NoteDocument): V2NoteDocument {
  const body = object(value, "note document");
  const meta = object(body["meta"], "note metadata");
  const note: V2NoteMeta = {
    noteId: identityString(meta["noteId"], "noteId"),
    path: text(meta["path"], "path"),
    title: text(meta["title"], "title"),
    tags: list(meta["tags"], "tags").map((tag) => text(tag, "tag")),
    revision: safeInteger(meta["revision"], "revision"),
    sourceHash: sourceHash(meta["sourceHash"], "sourceHash", "sha256-v2:"),
    diskHash: sourceHash(meta["diskHash"], "diskHash", "sha256:"),
    sourceHashFormatVersion: exactVersion(meta["sourceHashFormatVersion"], 2, "source hash"),
    diskHashFormatVersion: exactVersion(meta["diskHashFormatVersion"], 1, "disk hash"),
    updatedAtMs: safeInteger(meta["updatedAtMs"], "updatedAtMs"),
  };
  return { meta: note, content: text(body["content"], "content") };
}

function decodeWorkspaceTab(value: unknown): WorkspaceTab {
  const body = object(value, "workspace tab");
  const mode = body["mode"];
  if (mode !== "live" && mode !== "source") {
    throw corrupt("Workspace mode is unknown");
  }
  return {
    noteId: identityString(body["noteId"], "noteId"),
    title: text(body["title"], "title"),
    path: text(body["path"], "path"),
    selection: body["selection"] === null ? null : selection(body["selection"]),
    scrollTop: numberAtLeastZero(body["scrollTop"], "scrollTop"),
    mode,
  };
}

function decodeLegacySession(value: SessionState): SessionState {
  const body = object(value, "legacy session");
  const tab = (item: unknown) => {
    const entry = object(item, "legacy session tab");
    return {
      noteId: identityString(entry["noteId"], "noteId"),
      title: text(entry["title"], "title"),
      path: text(entry["path"], "path"),
      cursorOffset: entry["cursorOffset"] === null ? null : safeInteger(entry["cursorOffset"], "cursorOffset"),
      sourceMode: bool(entry["sourceMode"], "sourceMode"),
    };
  };
  return {
    openTabs: list(body["openTabs"], "openTabs", 500).map(tab),
    activeNoteId: body["activeNoteId"] === null ? null : identityString(body["activeNoteId"], "activeNoteId"),
    closedTabs: list(body["closedTabs"], "closedTabs", 500).map(tab),
  };
}

function emptyWorkspace(identity: ServerIdentity, workspace: WorkspaceId): WorkspaceState {
  return {
    formatVersion: 1,
    serverInstanceId: identity.serverInstanceId,
    vaultId: identity.vaultId,
    workspaceId: workspace,
    tabs: [],
    activeNoteId: null,
    closedTabs: [],
    pinnedNoteIds: [],
    recentNoteIds: [],
    searchHistory: [],
    legacySessionImported: false,
    savedAtMs: Date.now(),
  };
}

function assertWorkspaceKey(state: WorkspaceState, identity: ServerIdentity, workspace: WorkspaceId): void {
  if (state.serverInstanceId !== identity.serverInstanceId || state.vaultId !== identity.vaultId || state.workspaceId !== workspace) {
    throw corrupt("Workspace identity does not match its storage key");
  }
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const factory = globalThis.indexedDB;
    if (factory === undefined) {
      reject(new ClientStorageFailureError("unavailable", "IndexedDB is unavailable"));
      return;
    }
    const request = factory.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      const clean = db.createObjectStore(CLEAN_NOTES, {
        keyPath: ["formatVersion", "serverInstanceId", "vaultId", "noteId", "sourceHash"],
      });
      clean.createIndex(BY_NOTE_IDENTITY, ["serverInstanceId", "vaultId", "noteId"]);
      clean.createIndex(BY_CACHE_TIME, "cachedAtMs");
      db.createObjectStore(WORKSPACES, {
        keyPath: ["formatVersion", "serverInstanceId", "vaultId", "workspaceId"],
      });
      db.createObjectStore(DRAFTS, {
        keyPath: ["formatVersion", "serverInstanceId", "vaultId", "workspaceId", "noteId"],
      });
    };
    request.onblocked = () => reject(new ClientStorageFailureError("transaction", "IndexedDB upgrade is blocked"));
    request.onerror = () => reject(storageFailure(request.error));
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
  });
}

function deleteOtherHashes(store: IDBObjectStore, identity: DocumentIdentity, keep?: string): void {
  const cursor = store.index(BY_NOTE_IDENTITY).openCursor(IDBKeyRange.only([
    identity.serverInstanceId,
    identity.vaultId,
    identity.noteId,
  ]));
  cursor.onsuccess = () => {
    const current = cursor.result;
    if (current === null) {
      return;
    }
    const entry = current.value as CachedNoteBody;
    if (entry.sourceHash !== keep) {
      current.delete();
    }
    current.continue();
  };
}

function pruneCleanCache(store: IDBObjectStore): void {
  const count = store.count();
  count.onsuccess = () => {
    let remaining = count.result - MAX_CLEAN_NOTES;
    if (remaining <= 0) {
      return;
    }
    const cursor = store.index(BY_CACHE_TIME).openCursor();
    cursor.onsuccess = () => {
      const current = cursor.result;
      if (current === null || remaining <= 0) {
        return;
      }
      current.delete();
      remaining -= 1;
      current.continue();
    };
  };
}

function workspaceKey(identity: ServerIdentity, workspace: WorkspaceId): IDBValidKey {
  return [1, identity.serverInstanceId, identity.vaultId, workspace];
}

function draftKeyTuple(record: DraftJournalRecord): IDBValidKey {
  return [1, record.serverInstanceId, record.vaultId, record.workspaceId, record.noteId];
}

function draftKey(record: DraftJournalRecord): string {
  return draftIdentityKey(record, record.workspaceId, record.noteId);
}

function draftIdentityKey(
  identity: { serverInstanceId: string; vaultId: string },
  workspace: string,
  noteId: string,
): string {
  return JSON.stringify([identity.serverInstanceId, identity.vaultId, workspace, noteId]);
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
  });
}

function storageFailure(error: unknown): ClientStorageFailureError {
  if (error instanceof ClientStorageFailureError) {
    return error;
  }
  const name = error instanceof DOMException ? error.name : "";
  return new ClientStorageFailureError(name === "QuotaExceededError" ? "quota" : "transaction", "Browser storage operation failed", { cause: error });
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw corrupt(`${name} is not an object`);
  }
  return value as Record<string, unknown>;
}

function list(value: unknown, name: string, max = Number.MAX_SAFE_INTEGER): unknown[] {
  if (!Array.isArray(value) || value.length > max) {
    throw corrupt(`${name} is not a bounded array`);
  }
  return value;
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw corrupt(`${name} is not a string`);
  }
  return value;
}

function identityString(value: unknown, name: string): string {
  const result = text(value, name);
  if (result.length === 0 || result.trim() !== result) {
    throw corrupt(`${name} is not a valid identity`);
  }
  return result;
}

function safeInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw corrupt(`${name} is outside the safe integer range`);
  }
  return value;
}

function numberAtLeastZero(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw corrupt(`${name} is outside its supported range`);
  }
  return value;
}

function bool(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") {
    throw corrupt(`${name} is not a boolean`);
  }
  return value;
}

function version(value: unknown, expected: number, name: string): void {
  if (value !== expected) {
    throw corrupt(`${name} has an unsupported format version`);
  }
}

function exactVersion(value: unknown, expected: number, name: string): number {
  version(value, expected, name);
  return expected;
}

function sourceHash(value: unknown, name: string, prefix: "sha256:" | "sha256-v2:"): string {
  const result = text(value, name);
  if (!new RegExp(`^${prefix}[0-9a-f]{64}$`).test(result)) {
    throw corrupt(`${name} uses an unsupported hash format`);
  }
  return result;
}

function boundedMutationId(value: unknown): string {
  const result = identityString(value, "mutationId");
  if (new TextEncoder().encode(result).length > 128) {
    throw corrupt("mutationId exceeds 128 UTF-8 bytes");
  }
  return result;
}

function selection(value: unknown, sourceLength?: number): { anchor: number; head: number } {
  const body = object(value, "selection");
  const anchor = safeInteger(body["anchor"], "selection.anchor");
  const head = safeInteger(body["head"], "selection.head");
  if (sourceLength !== undefined && (anchor > sourceLength || head > sourceLength)) {
    throw corrupt("Selection is outside saved source");
  }
  return { anchor, head };
}

function corrupt(message: string): ClientStorageFailureError {
  return new ClientStorageFailureError("corrupt", message);
}
