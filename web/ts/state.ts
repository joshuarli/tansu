import type {
  V2ConflictDraftDocument,
  V2NoteDocument,
  V2NoteMeta,
  V2RevisionDocument,
  V2RevisionMeta,
  V2OverlayCoverage,
  V2SearchHit,
  V2VaultBootstrapResponse,
  V2VaultMeta,
} from "./types.generated.ts";
import type { DocumentSession } from "./app/document-session.ts";
import type { LocalDraftSession } from "./app/local-draft-session.ts";
import type { EditorSession } from "./editor/codemirror-adapter.ts";
import type { LocalDraftId, NoteId as IdentityNoteId, VaultId } from "./app/identity.ts";
import { toTabKey, type TabIdentity } from "./app/tab-identity.ts";
import type { WorkspaceTab } from "./app/workspace-store.ts";

declare const appBrand: unique symbol;

type AppBrand<T, Name extends string> = T & { readonly [appBrand]: Name };
export type NoteId = IdentityNoteId;
export type RevisionEventId = AppBrand<number, "RevisionEventId">;

export type ShellBootstrap = V2VaultBootstrapResponse & {
  serverInstanceId: string;
  vaults: V2VaultMeta[];
};

type TabFields = {
  key: string;
  title: string;
  path: string;
  draft: string | null;
  dirty: boolean;
  saving: boolean;
  conflict: boolean;
  selection: { anchor: number; head: number } | null;
  scrollTop: number;
  sourceMode: boolean;
  editorSession: EditorSession | null;
  editorRevision: number;
};

export type SavedTab = TabFields & {
  kind: "saved";
  noteId: NoteId;
  session: DocumentSession | null;
  doc: V2NoteDocument | null;
};

export type LocalDraftTab = TabFields & {
  kind: "local-draft";
  localDraftId: LocalDraftId;
  session: LocalDraftSession | null;
  doc: null;
};

export type Tab = SavedTab | LocalDraftTab;

export type NoteDialog =
  | { kind: "create"; localDraftId: LocalDraftId; title: string }
  | { kind: "rename"; noteId: NoteId; title: string }
  | { kind: "tag"; value: string }
  | { kind: "delete"; noteId: NoteId };

export type ContextMenuState = {
  noteId: NoteId;
  x: number;
  y: number;
};

export type State = {
  theme: "light" | "dark";
  authRequired: boolean;
  authBusy: "login" | "enroll" | "logout" | null;
  authError: string | null;
  authCapability: string;
  boot: ShellBootstrap | null;
  serverInstanceId: string | null;
  vault: VaultId;
  notes: Map<string, V2NoteMeta>;
  pinned: Set<string>;
  recent: string[];
  searchHistory: string[];
  tabs: Tab[];
  closedTabs: WorkspaceTab[];
  activeTab: TabIdentity | null;
  searchOpen: boolean;
  findOpen: boolean;
  findQuery: string;
  findIndex: number;
  searchOverlayQuery: string;
  searchOverlayHits: V2SearchHit[] | null;
  searchOverlayCoverage: V2OverlayCoverage | null;
  commandOpen: boolean;
  commandFilter: string;
  revisionsOpen: boolean;
  revisionNoteId: NoteId | null;
  revisionList: V2RevisionMeta[] | null;
  revisionDocument: V2RevisionDocument | null;
  conflictDraft: V2ConflictDraftDocument | null;
  settingsOpen: boolean;
  storagePersisted: boolean | null;
  noteDialog: NoteDialog | null;
  contextMenu: ContextMenuState | null;
  notice: string | null;
  imageUploads: Set<number>;
  readingMode: boolean;
};

export function createState(vault: VaultId): State {
  return {
    theme: "light",
    authRequired: false,
    authBusy: null,
    authError: null,
    authCapability: "",
    boot: null,
    serverInstanceId: null,
    vault,
    notes: new Map(),
    pinned: new Set(),
    recent: [],
    searchHistory: [],
    tabs: [],
    closedTabs: [],
    activeTab: null,
    searchOpen: false,
    findOpen: false,
    findQuery: "",
    findIndex: 0,
    searchOverlayQuery: "",
    searchOverlayHits: null,
    searchOverlayCoverage: null,
    commandOpen: false,
    commandFilter: "",
    revisionsOpen: false,
    revisionNoteId: null,
    revisionList: null,
    revisionDocument: null,
    conflictDraft: null,
    settingsOpen: false,
    storagePersisted: null,
    noteDialog: null,
    contextMenu: null,
    notice: null,
    imageUploads: new Set(),
    readingMode: false,
  };
}

export function toNoteId(value: string): NoteId {
  return value as NoteId;
}

export function toRevisionEventId(value: number): RevisionEventId {
  return value as RevisionEventId;
}

export function activeTab(state: State): Tab | undefined {
  if (state.activeTab === null) return undefined;
  const key = toTabKey(state.activeTab);
  return state.tabs.find((tab) => tab.key === key);
}

export function tabById(state: State, noteId: string): SavedTab | undefined {
  return state.tabs.find((tab): tab is SavedTab => tab.kind === "saved" && tab.noteId === noteId);
}

export function tabIdentity(tab: Tab): TabIdentity {
  return tab.kind === "saved"
    ? { kind: "saved", noteId: tab.noteId }
    : { kind: "local-draft", localDraftId: tab.localDraftId };
}

export function tabFromMeta(note: V2NoteMeta): SavedTab {
  return {
    kind: "saved",
    key: toTabKey({ kind: "saved", noteId: toNoteId(note.noteId) }),
    noteId: toNoteId(note.noteId),
    title: note.title,
    path: note.path,
    session: null,
    doc: null,
    draft: null,
    dirty: false,
    saving: false,
    conflict: false,
    selection: null,
    scrollTop: 0,
    sourceMode: false,
    editorSession: null,
    editorRevision: 0,
  };
}

export function tabFromDocument(document: V2NoteDocument): SavedTab {
  const content = normalizeMarkdownNewlines(document.content);
  const doc = content === document.content ? document : { ...document, content };
  return {
    ...tabFromMeta(doc.meta),
    doc,
    draft: doc.content,
  };
}

export function tabFromWorkspace(tab: WorkspaceTab): Tab {
  const fields: TabFields = {
    key: toTabKey(tab.kind === "saved" ? { kind: "saved", noteId: toNoteId(tab.noteId) } : tab),
    title: tab.title,
    path: tab.path,
    draft: null,
    dirty: tab.kind === "local-draft",
    saving: false,
    conflict: false,
    selection: tab.selection,
    scrollTop: tab.scrollTop,
    sourceMode: tab.mode === "source",
    editorSession: null,
    editorRevision: 0,
  };
  return tab.kind === "saved"
    ? { ...fields, kind: "saved", noteId: toNoteId(tab.noteId), session: null, doc: null }
    : { ...fields, kind: "local-draft", localDraftId: tab.localDraftId, session: null, doc: null };
}

export function loadedDraft(tab: Tab): string | null {
  if (tab.kind === "local-draft") return tab.session?.state.source ?? tab.draft;
  if (tab.session !== null) {
    const session = tab.session.state;
    if (session.status === "loading" ||
      session.status === "unavailable" && session.draft === null) return null;
    return session.draft.source;
  }
  return tab.doc === null ? null : (tab.draft ?? tab.doc.content);
}

export function tabIsDirty(tab: Tab): boolean {
  if (tab.dirty) return true;
  if (tab.kind === "local-draft") return true;
  if (tab.session === null) return tab.dirty;
  const session = tab.session.state;
  const status = session.status;
  return status === "dirty" || status === "saving" || status === "conflict" ||
    status === "unavailable" && session.draft !== null;
}

export function workspaceTabFromTab(tab: Tab): WorkspaceTab {
  const fields = {
    title: tab.title,
    path: tab.path,
    selection: tab.selection,
    scrollTop: tab.scrollTop,
    mode: tab.sourceMode ? "source" as const : "live" as const,
  };
  return tab.kind === "saved"
    ? { ...fields, kind: "saved", noteId: tab.noteId }
    : { ...fields, kind: "local-draft", localDraftId: tab.localDraftId };
}

export function normalizeMarkdownNewlines(markdown: string): string {
  return markdown.replaceAll(/\r\n?/g, "\n");
}
