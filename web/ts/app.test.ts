import { isolateHistory, undo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";

import { startApp, TansuApp } from "./app.ts";
import { defaultServices, type AppServices } from "./app/services.ts";
import {
  cacheNoteBody,
  deleteCachedNoteBodies,
  DraftJournal,
  getCachedNoteBody,
  getDraftCheckpoint,
  getLocalDraftCheckpoint,
  getWorkspaceState,
  saveWorkspaceState,
  writeDraftCheckpoint,
} from "./app/workspace-store.ts";
import { canonicalSourceHash } from "./source-hash.ts";
import { V2ApiError, type V2VaultBootstrap, type V2VaultClient, type V2VaultSnapshot } from "./app/v2-api.ts";
import { localDraftId, noteId, serverInstanceId, vaultId, workspaceId } from "./app/identity.ts";
import type { EditorConfig } from "./editor/tansu-extensions.ts";
import { createCodeMirrorEditor, type EditorHandle, type EditorSession, type EditorSnapshot } from "./editor/codemirror-adapter.ts";
import type {
  Settings,
  V2BootstrapResponse,
  V2ConflictDraftDocument,
  V2CreateNoteRequest,
  V2MutationResponse,
  V2NoteDocument,
  V2NoteMeta,
  V2RevisionDocument,
  V2RevisionMeta,
  V2SaveNoteRequest,
  V2SearchRequest,
  V2SearchResponse,
  V2SettingsRequest,
  V2VaultBootstrapResponse,
} from "./types.generated.ts";
import type { DraftJournalRecord, LocalDraftJournalRecord, WorkspaceState, WorkspaceTab } from "./app/workspace-store.ts";

const HASH_A = `blake3-v3:${"a".repeat(64)}`;
const HASH_B = `blake3-v3:${"b".repeat(64)}`;
const DISK_HASH = `blake3-v2:${"c".repeat(64)}`;
const DEFAULT_VAULT = "vault-1";
const WORKSPACE_ID = workspaceId("workspace-1");

type TestClient = ReturnType<typeof createTestClient>;

const clients = new Map<string, TestClient>();
let workspaceSeeds = Promise.resolve();
const memory = {
  workspaceWrites: [] as WorkspaceState[],
};
const apps: TansuApp[] = [];
const api = {
  bootstrap: vi.fn(async (): Promise<V2BootstrapResponse> => ({
    apiVersion: 2,
    serverInstanceId: "server-1",
    vaults: [{ vaultId: DEFAULT_VAULT, name: "Notes" }, { vaultId: "vault-2", name: "Other notes" }],
  })),
  forVault: vi.fn((_server: string, id: string): TestClient => testClient(id)),
};
const editorMock = { instances: [] as FakeEditor[] };

describe("v2 desktop shell", () => {
  beforeEach(() => {
    clients.clear();
    workspaceSeeds = Promise.resolve();
    vi.stubGlobal("indexedDB", new IDBFactory());
    vi.stubGlobal("IDBKeyRange", IDBKeyRange);
    localStorage.clear();
    localStorage.setItem("tansu.workspace.v1", "workspace-1");
    memory.workspaceWrites.length = 0;
    editorMock.instances.length = 0;
    api.bootstrap.mockReset().mockResolvedValue({
      apiVersion: 2,
      serverInstanceId: "server-1",
      vaults: [{ vaultId: DEFAULT_VAULT, name: "Notes" }, { vaultId: "vault-2", name: "Other notes" }],
    });
    api.forVault.mockClear();
    let sequence = 0;
    vi.stubGlobal("crypto", {
      randomUUID: vi.fn(() => `mutation-${++sequence}`),
      subtle: {
        digest: vi.fn(async (_algorithm: AlgorithmIdentifier, input: BufferSource) => {
          const bytes = new Uint8Array(input as ArrayBuffer);
          const digest = new Uint8Array(32);
          bytes.forEach((byte, index) => {
            const position = index % digest.length;
            digest[position] = (digest[position] ?? 0) ^ byte;
          });
          return digest.buffer;
        }),
      },
    });
    document.body.replaceChildren();
  });

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.dispose()));
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  it("deduplicates a render-triggered V2 note load", async () => {
    const note = noteMeta("note-1", "one.md", "One");
    const client = configureVault([note, noteMeta("note-2", "two.md", "Two")]);
    const load = deferred<V2NoteDocument>();
    client.openNote.mockReturnValue(load.promise);
    const { app, root } = mountApp();
    await app.boot();
    await openRecentNote(root);
    await flushAsync();
    expect(client.openNote).toHaveBeenCalledTimes(1);
    expect(client.openNote).toHaveBeenCalledWith(note.noteId);
    load.resolve(documentFor(note, "# One\n"));
    await flushAsync();
    expect(root.textContent).toContain("One");
  });

  it("loads a note reopened while its previous tab load is pending", async () => {
    const note = noteMeta("note-1", "one.md", "One");
    const client = configureVault([note, noteMeta("note-2", "two.md", "Two")]);
    const load = deferred<V2NoteDocument>();
    client.openNote.mockReturnValue(load.promise);
    const { app, root } = mountApp();
    await app.boot();

    await openRecentNote(root);
    await flushAsync();
    root.querySelector<HTMLButtonElement>(".tab-close")?.click();
    await flushAsync();
    await openRecentNote(root);
    await flushAsync();

    expect(client.openNote).toHaveBeenCalledTimes(2);
    load.resolve(documentFor(note, "# One\n"));
    await until(() => editorMock.instances[0]?.getSnapshot()?.source === "# One\n");
    expect(root.textContent).toContain("One");
  });

  it("shows the empty-vault notice when bootstrap has no configured vaults", async () => {
    useFakeTimers();
    api.bootstrap.mockResolvedValueOnce({ apiVersion: 2, serverInstanceId: "server-1", vaults: [] });
    const { app, root } = mountApp();

    await app.boot();

    expect(root.querySelector(".sidebar")).toBeNull();
    expect(root.querySelector(".empty-state h1")?.textContent).toBe("No vault is configured");
    await vi.advanceTimersByTimeAsync(2500);
    expect(root.querySelector(".empty-state h1")?.textContent).toBe("No vault is configured");
    expect(root.querySelector(".loading")).toBeNull();
    expect(api.forVault).not.toHaveBeenCalled();
  });

  it("restores the loading view when the initial bootstrap fails", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    const bootstrap = vi.spyOn(defaultServices.api, "bootstrap").mockRejectedValue(new Error("offline"));
    const app = startApp(root);
    apps.push(app);
    try {
      await until(() => root.querySelector(".loading") !== null);
      expect(root.querySelector(".loading")).not.toBeNull();
    } finally {
      bootstrap.mockRestore();
    }
  });

  it("flushes workspace and draft state before the page unloads", async () => {
    const note = noteMeta("note-1", "one.md", "One");
    configureVault([note], workspaceSeed([
      { noteId: note.noteId, title: note.title, path: note.path, cursorOffset: null, sourceMode: false },
    ], note.noteId));
    const services = createServices();
    const journal = new DraftJournal(() => {});
    const flushAll = vi.spyOn(journal, "flushAll");
    vi.spyOn(services.workspace, "createJournal").mockReturnValue(journal);
    const { app } = mountApp(services);
    app.bindGlobalEvents();
    await app.boot();
    editorMock.instances[0]!.revealSelection({ anchor: 2, head: 2 });
    window.dispatchEvent(new Event("beforeunload"));
    await until(() => memory.workspaceWrites.some((state) => state.tabs[0]?.selection?.anchor === 2));

    expect((await storedWorkspace())?.tabs).toMatchObject([{ kind: "saved", noteId: note.noteId, selection: { anchor: 2, head: 2 } }]);
    expect(flushAll).toHaveBeenCalledTimes(1);
  });

  it("keeps the current vault mounted when bootstrap temporarily returns no vaults", async () => {
    const note = noteMeta("note-1", "one.md", "One");
    const client = configureVault([note], workspaceSeed([
      { noteId: note.noteId, title: note.title, path: note.path, cursorOffset: null, sourceMode: false },
    ], note.noteId));
    const { app, root } = mountApp();
    await app.boot();
    await flushAsync();
    api.bootstrap.mockResolvedValueOnce({ apiVersion: 2, serverInstanceId: "server-1", vaults: [] });

    await app.boot();

    expect(root.querySelector(".main")).not.toBeNull();
    expect(root.textContent).toContain("No vault is configured");
    expect(client.connectEvents).toHaveBeenCalledTimes(2);
  });

  it("opens the command palette from Mod+K and closes it with Escape", async () => {
    configureVault([]);
    const { app, root } = mountApp();
    app.bindGlobalEvents();
    await app.boot();

    const open = new KeyboardEvent("keydown", { key: "k", ctrlKey: true, cancelable: true });
    window.dispatchEvent(open);
    await flushAsync();
    expect(open.defaultPrevented).toBeTruthy();
    expect(root.querySelector(".command-panel")).not.toBeNull();

    const close = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    window.dispatchEvent(close);
    await flushAsync();
    expect(close.defaultPrevented).toBeTruthy();
    expect(root.querySelector(".command-panel")).toBeNull();
  });

  it("opens the command palette from Ctrl+P", async () => {
    configureVault([]);
    const { app, root } = mountApp();
    app.bindGlobalEvents();
    await app.boot();

    const open = new KeyboardEvent("keydown", { key: "p", ctrlKey: true, cancelable: true });
    window.dispatchEvent(open);
    await flushAsync();

    expect(open.defaultPrevented).toBeTruthy();
    expect(root.querySelector(".command-panel")).not.toBeNull();
    expect(root.textContent).toContain("Settings");
  });

  it("opens a new note tab with Ctrl+N and Ctrl+T", async () => {
    configureVault([]);
    const { app, root } = mountApp();
    app.bindGlobalEvents();
    await app.boot();

    for (const key of ["n", "t"]) {
      const open = new KeyboardEvent("keydown", { key, ctrlKey: true, cancelable: true });
      window.dispatchEvent(open);
      expect(open.defaultPrevented).toBeTruthy();
      await until(() => root.querySelectorAll(".tab").length === (key === "n" ? 1 : 2));
      expect(root.querySelector(".note-dialog-panel")).toBeNull();
    }
  });

  it("opens keyboard shortcut help with Escape and closes it with Escape", async () => {
    configureVault([]);
    const { app, root } = mountApp();
    app.bindGlobalEvents();
    await app.boot();

    const open = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    window.dispatchEvent(open);
    await flushAsync();
    expect(open.defaultPrevented).toBeTruthy();
    expect(root.textContent).toContain("Keyboard shortcuts");
    expect(root.textContent).toContain("Find in current note");

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    await flushAsync();
    expect(root.textContent).not.toContain("Keyboard shortcuts");
  });

  it("cycles light, dark and paper themes and persists the choice", async () => {
    window.localStorage.removeItem("tansu.theme.v1");
    configureVault([]);
    const { app, root } = mountApp();
    await app.boot();
    const themes: Array<string | undefined> = [document.documentElement.dataset["theme"]];
    for (let index = 0; index < 3; index += 1) {
      root.querySelector<HTMLButtonElement>(".theme-toggle")!.click();
      themes.push(document.documentElement.dataset["theme"]);
      expect(window.localStorage.getItem("tansu.theme.v1")).toBe(document.documentElement.dataset["theme"]);
    }
    expect(themes).toStrictEqual(["light", "dark", "paper", "light"]);

    window.localStorage.setItem("tansu.theme.v1", "paper");
    mountApp();
    expect(document.documentElement.dataset["theme"]).toBe("paper");
    window.localStorage.removeItem("tansu.theme.v1");
  });

  it("toggles focus mode from the shortcut, shows a hint, and exits with Escape", async () => {
    useFakeTimers();
    configureVault([]);
    const { app, root } = mountApp();
    await app.boot();
    const main = () => root.querySelector(".main")!;

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, shiftKey: true, cancelable: true }));
    expect(main().classList.contains("focus-mode")).toBeTruthy();
    expect(main().classList.contains("focus-mode")).toBeTruthy();

    const escape = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    window.dispatchEvent(escape);
    expect(escape.defaultPrevented).toBeTruthy();
    expect(main().classList.contains("focus-mode")).toBeFalsy();
    expect(root.textContent).not.toContain("Keyboard shortcuts");
  });

  it("closes a note context menu when the user clicks outside it", async () => {
    const note = noteMeta("note-1", "one.md", "One");
    configureVault([note]);
    const { app, root } = mountApp();
    app.bindGlobalEvents();
    await app.boot();
    await openSearch(root);
    const row = root.querySelector<HTMLElement>(".recent-search-result");
    if (row === null) throw new Error("Expected a note row");

    row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 20, clientY: 20 }));
    await flushAsync();
    expect(root.querySelector(".context-menu-item")).not.toBeNull();
    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushAsync();
    expect(root.querySelector(".context-menu-item")).toBeNull();
  });

  it("shows the passkey gate after auth expires and returns to the vault after login", async () => {
    vi.stubGlobal("navigator", { ...navigator, credentials: {} });
    vi.stubGlobal("isSecureContext", true);
    const services = createServices();
    api.bootstrap.mockRejectedValueOnce(new V2ApiError("Authentication required", 401, { code: "auth_required" }));
    const login = vi.fn(async () => {});
    services.passkeys.login = login;
    const { app, root } = mountApp(services);

    await app.boot();
    expect(root.querySelector(".auth-gate")?.textContent).toContain("Unlock your notes");
    root.querySelector<HTMLButtonElement>('[title="Sign in with passkey"]')?.click();
    await until(() => root.querySelector(".main") !== null);

    expect(login).toHaveBeenCalledTimes(1);
    expect(root.querySelector(".auth-gate")).toBeNull();
  });

  it("enrolls the first passkey with the one-time capability", async () => {
    vi.stubGlobal("navigator", { ...navigator, credentials: {} });
    vi.stubGlobal("isSecureContext", true);
    const services = createServices();
    api.bootstrap.mockRejectedValueOnce(new V2ApiError("Authentication required", 401, { code: "auth_required" }));
    const enroll = vi.fn(async (_capability?: string) => {});
    services.passkeys.enroll = enroll;
    const { app, root } = mountApp(services);
    await app.boot();
    const capability = root.querySelector<HTMLInputElement>(".auth-card input")!;
    capability.value = "first-use-capability";
    capability.dispatchEvent(new Event("input", { bubbles: true }));
    root.querySelector<HTMLButtonElement>('[title="Register first passkey"]')?.click();
    await until(() => root.querySelector(".main") !== null);

    expect(enroll).toHaveBeenCalledWith("first-use-capability");
  });

  it("locks the shell after a protected save reports an expired session", async () => {
    const note = noteMeta("note-1", "one.md", "One");
    const client = configureVault([note], workspaceSeed([
      { noteId: note.noteId, title: note.title, path: note.path, cursorOffset: null, sourceMode: false },
    ], note.noteId));
    client.saveNote.mockRejectedValue(new V2ApiError("Authentication required", 401, { code: "auth_required" }));
    const { app, root } = mountApp();
    app.bindGlobalEvents();
    await app.boot();
    editorMock.instances[0]!.simulateEdit("# Local draft\n");
    await flushEditorCapture();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "s", ctrlKey: true, cancelable: true }));
    await until(() => root.querySelector(".auth-gate") !== null);

    expect(root.textContent).toContain("Unlock your notes");
    expect(root.querySelector(".editor-mount")).toBeNull();
    expect((await savedCheckpoint(note.noteId))?.source).toBe("# Local draft\n");
  });

  it("locks the session from settings after flushing workspace state", async () => {
    const services = createServices();
    const logout = vi.fn(async () => {});
    services.passkeys.logout = logout;
    configureVault([]);
    const { app, root } = mountApp(services);
    await app.boot();
    await runCommand(root, "settings");
    root.querySelector<HTMLButtonElement>('[title="Lock this session"]')?.click();
    await until(() => root.querySelector(".auth-gate") !== null);

    expect(logout).toHaveBeenCalledTimes(1);
    expect(await storedWorkspace()).not.toBeNull();
  });

  it("requests persistent storage from the settings user gesture", async () => {
    const services = createServices();
    const requestPersistent = vi.fn(async () => true);
    services.storage.requestPersistent = requestPersistent;
    configureVault([]);
    const { app, root } = mountApp(services);
    await app.boot();
    await runCommand(root, "settings");
    root.querySelector<HTMLButtonElement>('[title="Request persistent storage"]')?.click();
    await until(() => root.textContent?.includes("Persistent browser storage is enabled.") === true);

    expect(requestPersistent).toHaveBeenCalledTimes(1);
  });

  it("opens current-note find with Mod+F and restores editor focus and selection on Escape", async () => {
    const note = noteMeta("note-1", "one.md", "One");
    configureVault([note], workspaceSeed([
      { noteId: note.noteId, title: note.title, path: note.path, cursorOffset: 5, sourceMode: false },
    ], note.noteId));
    const { app, root } = mountApp();
    app.bindGlobalEvents();
    await app.boot();
    const editor = editorMock.instances[0]!;
    const editorMount = root.querySelector<HTMLElement>("#editor-mount")!;
    const focusTarget = document.createElement("input");
    editorMount.append(focusTarget);
    focusTarget.focus();
    vi.mocked(editor.find).mockReturnValue([{ from: 2, to: 5 }]);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true, cancelable: true }));
    await flushAsync();

    expect(root.querySelector(".find-bar")).not.toBeNull();
    expect(root.querySelector(".search-panel")).toBeNull();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    await flushAsync();
    expect(editor.revealSelection).toHaveBeenCalledWith({ anchor: 5, head: 5 });
    expect(editor.focus).toHaveBeenCalled();

    vi.mocked(editor.revealSelection).mockClear();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true, cancelable: true }));
    await flushAsync();
    const findInput = root.querySelector<HTMLInputElement>('[data-key="current-note-find"]')!;
    findInput.value = "body";
    findInput.dispatchEvent(new Event("input", { bubbles: true }));
    root.querySelector<HTMLButtonElement>(".find-next")?.click();
    expect(editor.revealFindMatch).toHaveBeenCalledWith({ from: 2, to: 5 });
    expect(editor.setFindHighlights).toHaveBeenCalledWith({
      matches: [{ from: 2, to: 5 }],
      selected: { from: 2, to: 5 },
    });
    expect(editor.revealSelection).not.toHaveBeenCalled();
    expect(editor.focus).toHaveBeenCalled();
    expect(root.querySelector("#editor-mount")).toBe(editorMount);
    expect(editorMock.instances).toHaveLength(1);
  });

  it("requeries stale search hits without applying their source range", async () => {
    const note = noteMeta("note-1", "one.md", "One");
    const client = configureVault([note]);
    client.search.mockResolvedValue(searchResponse([{
      ...searchHit(note),
      sourceRange: { startUtf16: 0, endUtf16: 3 },
    }]));
    client.openNote.mockResolvedValue(documentFor(noteMeta(note.noteId, note.path, note.title, [], 2, HASH_B), "# New\n"));
    const { app, root } = mountApp();
    await app.boot();
    await openSearch(root);
    const input = root.querySelector<HTMLInputElement>(".search-panel input")!;
    input.value = "one";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await until(() => root.querySelector(".search-panel .search-result-row") !== null);
    root.querySelector<HTMLButtonElement>(".search-panel .search-result-row")?.click();
    await until(() => client.search.mock.calls.length === 2);

    expect(editorMock.instances[0]?.revealSelection).not.toHaveBeenCalled();
    expect(root.querySelector(".search-panel")).not.toBeNull();
  });

  it("uses a valid cached document immediately and preserves a local edit when canonical content changes", async () => {
    const note = noteMeta("note-1", "one.md", "One");
    const client = configureVault([note], workspaceSeed([
      { noteId: note.noteId, title: note.title, path: note.path, cursorOffset: 1, sourceMode: false },
    ], note.noteId));
    await storeCachedBody(note, "# Cached\n");
    const load = deferred<V2NoteDocument>();
    client.openNote.mockReturnValue(load.promise);
    const { app, root } = mountApp();
    const boot = app.boot();
    await until(() => editorMock.instances[0]?.getSnapshot()?.source === "# Cached\n");
    const editor = editorMock.instances[0]!;
    editor.simulateEdit("# Local edit\n");
    await flushEditorCapture();
    const newer = noteMeta(note.noteId, note.path, note.title, [], 2, HASH_B);
    load.resolve(documentFor(newer, "# Canonical\n"));
    await boot;
    expect(editor.getSnapshot()?.source).toBe("# Local edit\n");
    expect(root.textContent).toContain("Save conflict");
  });

  it("clamps an imported cursor after its note is shortened", async () => {
    const note = noteMeta("note-1", "one.md", "One");
    const client = configureVault([note], workspaceSeed([
      { noteId: note.noteId, title: note.title, path: note.path, cursorOffset: 80, sourceMode: false },
    ], note.noteId));
    client.openNote.mockResolvedValue(documentFor(note, "short"));
    const { app } = mountApp();
    await app.boot();
    expect(editorMock.instances[0]?.getSnapshot()?.selection).toStrictEqual({ anchor: 5, head: 5 });
  });

  it("ignores a stale cached body and stays loading until V2 content arrives", async () => {
    const note = noteMeta("note-1", "one.md", "One");
    configureVault([note], workspaceSeed([
      { noteId: note.noteId, title: note.title, path: note.path, cursorOffset: null, sourceMode: false },
    ], note.noteId));
    await storeCachedBody({ ...note, sourceHash: HASH_B }, "# Stale\n");
    const load = deferred<V2NoteDocument>();
    testClient().openNote.mockReturnValue(load.promise);
    const { app, root } = mountApp();
    const boot = app.boot();
    await flushAsync();
    expect(editorMock.instances).toHaveLength(0);
    expect(root.textContent).toContain("Loading");
    load.resolve(documentFor(note, "# Canonical\n"));
    await boot;
    expect(editorMock.instances[0]?.getSnapshot()?.source).toBe("# Canonical\n");
  });

  it("opens a note from a recent row using valid cache before the network response", async () => {
    const note = noteMeta("note-1", "one.md", "One");
    const client = configureVault([note, noteMeta("note-2", "two.md", "Two")]);
    const load = deferred<V2NoteDocument>();
    client.openNote.mockReturnValue(load.promise);
    await storeCachedBody(note, "# Cached recent\n");
    const { app, root } = mountApp();
    await app.boot();
    await openRecentNote(root);
    await until(() => editorMock.instances[0]?.getSnapshot()?.source === "# Cached recent\n");
    expect(client.openNote).toHaveBeenCalledWith(note.noteId);
    load.resolve(documentFor(note, "# Cached recent\n"));
    await flushAsync();
  });

  it("keeps the loading state on a cache miss until the note opens", async () => {
    const note = noteMeta("note-1", "one.md", "One");
    const client = configureVault([note, noteMeta("note-2", "two.md", "Two")]);
    const load = deferred<V2NoteDocument>();
    client.openNote.mockReturnValue(load.promise);
    const { app, root } = mountApp();
    await app.boot();
    await openRecentNote(root);
    await flushAsync();
    expect(editorMock.instances).toHaveLength(0);
    expect(root.textContent).toContain("Loading");
    load.resolve(documentFor(note, "# Server\n"));
    await until(() => editorMock.instances[0]?.getSnapshot()?.source === "# Server\n");
  });

  it("hides the previous editor session while the next tab is loading", async () => {
    const first = noteMeta("one", "one.md", "One");
    const second = noteMeta("two", "two.md", "Two");
    const client = configureVault([first, second], workspaceSeed([
      { noteId: first.noteId, title: first.title, path: first.path, cursorOffset: null, sourceMode: false },
      { noteId: second.noteId, title: second.title, path: second.path, cursorOffset: null, sourceMode: false },
    ], first.noteId));
    const pending = deferred<V2NoteDocument>();
    client.openNote.mockImplementation(async (id) => id === second.noteId ? pending.promise : documentFor(first, "# One\n"));
    const { app, root } = mountApp();
    await app.boot();
    const editor = editorMock.instances[0]!;
    const editorMount = root.querySelector<HTMLElement>("#editor-mount")!;
    expect(editor.getSnapshot()?.source).toBe("# One\n");

    root.querySelector<HTMLButtonElement>('[title="Two"]')?.click();
    await until(() => root.querySelector(".workspace .loading") !== null);
    expect(root.querySelector("#editor-mount")).toBe(editorMount);
    expect(editorMount.hidden).toBeTruthy();
    expect(editorMount.inert).toBeTruthy();

    pending.resolve(documentFor(second, "# Two\n"));
    await until(() => editor.getSnapshot()?.source === "# Two\n");
    expect(root.querySelector("#editor-mount")).toBe(editorMount);
    expect(editorMount.hidden).toBeFalsy();
    expect(editor.getSnapshot()?.noteId).toBe("saved:two");
  });

  it("hides and detaches the editor after closing the last tab", async () => {
    const note = noteMeta("one", "one.md", "One");
    configureVault([note], workspaceSeed([
      { noteId: note.noteId, title: note.title, path: note.path, cursorOffset: null, sourceMode: false },
    ], note.noteId));
    const { app, root } = mountApp();
    await app.boot();
    const editor = editorMock.instances[0]!;
    const editorMount = root.querySelector<HTMLElement>("#editor-mount")!;
    expect(editor.getSnapshot()?.source).toBe("# One\n");

    root.querySelector<HTMLButtonElement>(".tab-close")?.click();

    expect(root.querySelector(".empty-state")?.textContent).toContain("No note selected");
    expect(root.querySelector("#editor-mount")).toBe(editorMount);
    expect(editorMount.hidden).toBeTruthy();
    expect(editorMount.inert).toBeTruthy();
    expect(editor.getSnapshot()).toBeNull();
  });

  it("reopens a closed tab from cache before its network response", async () => {
    const note = noteMeta("note-1", "one.md", "One");
    const client = configureVault([note, noteMeta("note-2", "two.md", "Two")], workspaceSeed([], null, [
      { noteId: note.noteId, title: note.title, path: note.path, cursorOffset: 3, sourceMode: true },
    ]));
    const load = deferred<V2NoteDocument>();
    client.openNote.mockReturnValue(load.promise);
    await storeCachedBody(note, "# Cached reopen\n");
    const { app, root } = mountApp();
    await app.boot();
    await runCommand(root, "reopen");
    await until(() => editorMock.instances[0]?.getSnapshot()?.source === "# Cached reopen\n");
    expect(editorMock.instances[0]?.getSnapshot()).toMatchObject({ mode: "source", selection: { anchor: 3, head: 3 } });
    load.resolve(documentFor(note, "# Cached reopen\n"));
    await flushAsync();
  });

  it("does not reread cache or replace an already-loaded tab", async () => {
    const note = noteMeta("note-1", "one.md", "One");
    const services = createServices();
    const readCache = vi.spyOn(services.workspace, "getCachedNoteBody");
    const client = configureVault([note], workspaceSeed([
      { noteId: note.noteId, title: note.title, path: note.path, cursorOffset: null, sourceMode: false },
    ], note.noteId));
    client.openNote.mockResolvedValue(documentFor(note, "# Canonical\n"));
    const root = document.createElement("div");
    document.body.append(root);
    const app = new TansuApp(root, services);
    apps.push(app);
    app.bindGlobalEvents();
    await app.boot();
    readCache.mockClear();
    await openRecentNote(root);
    await flushAsync();
    expect(readCache).not.toHaveBeenCalled();
    expect(client.openNote).toHaveBeenCalledTimes(1);
    expect(editorMock.instances[0]?.getSnapshot()?.source).toBe("# Canonical\n");
  });

  it("ignores an older vault bootstrap after switching vaults", async () => {
    const first = noteMeta("first", "first.md", "First");
    const second = noteMeta("second", "second.md", "Second");
    const oldClient = configureVault([first], null, DEFAULT_VAULT);
    const newClient = configureVault([second], null, "vault-2");
    const oldBoot = deferred<V2VaultBootstrap>();
    oldClient.bootstrap.mockReturnValue(oldBoot.promise);
    newClient.bootstrap.mockResolvedValue(vaultBootstrap([second], "vault-2"));
    const { app, root } = mountApp();
    const oldRequest = app.boot();
    await app.boot("vault-2");
    expect(root.textContent).toContain("Second");
    oldBoot.resolve(vaultBootstrap([first]));
    await oldRequest;
    expect(root.textContent).toContain("Second");
    expect(root.textContent).not.toContain("First");
  });

  it("keeps the old vault event stream live when an outgoing flush fails", async () => {
    const oldNote = noteMeta("first", "first.md", "First");
    const updatedNote = noteMeta(oldNote.noteId, "updated.md", "Updated", [], 2, HASH_B);
    const oldClient = configureVault([oldNote], workspaceSeed([
      { noteId: oldNote.noteId, title: oldNote.title, path: oldNote.path, cursorOffset: null, sourceMode: false },
    ], oldNote.noteId));
    const nextClient = configureVault([noteMeta("second", "second.md", "Second")], null, "vault-2");
    const services = createServices();
    const journal = new DraftJournal(() => {});
    vi.spyOn(journal, "flushAll").mockRejectedValueOnce(new Error("storage unavailable"));
    vi.spyOn(services.workspace, "createJournal").mockReturnValue(journal);
    const root = document.createElement("div");
    document.body.append(root);
    const app = new TansuApp(root, services);
    apps.push(app);
    await app.boot();
    expect(oldClient.connectEvents).toHaveBeenCalledTimes(1);

    await app.boot("vault-2");

    expect(root.textContent).toContain("First");
    expect(root.textContent).toContain("Local recovery storage failed");
    expect(oldClient.connectEvents).toHaveBeenCalledTimes(2);
    expect(nextClient.connectEvents).not.toHaveBeenCalled();
    oldClient.openNote.mockResolvedValue(documentFor(updatedNote, "# Updated\n"));
    const snapshot: V2VaultSnapshot = {
      bootstrap: { ...vaultBootstrap([updatedNote]), searchStatus: { dirty: false, degraded: true } },
      notes: [updatedNote],
      eventVersion: 2,
    };
    await oldClient.eventHandlers?.onResync(snapshot);
    expect(root.textContent).toContain("Updated");
    expect(root.textContent).toContain("Search degraded");
  });

  it("merges watcher note updates without dropping unaffected notes", async () => {
    const first = noteMeta("first", "first.md", "First");
    const second = noteMeta("second", "second.md", "Second");
    const updated = noteMeta(second.noteId, "renamed.md", "Renamed", [], 2, HASH_B);
    const client = configureVault([first, second]);
    const { app, root } = mountApp();
    await app.boot();
    await openSearch(root);

    client.eventHandlers?.onEvent({
      eventVersion: 1,
      resyncRequired: false,
      update: { kind: "vaultChanged", notes: [updated] },
    });
    await until(() => root.textContent?.includes("Renamed") && root.textContent.includes("First"));

    expect(root.textContent).toContain("First");
    expect(root.textContent).toContain("Renamed");
    expect(root.textContent).not.toContain("Second");
  });

  it("reconnects the old event stream when the global bootstrap fails", async () => {
    const note = noteMeta("note-1", "one.md", "One");
    const oldClient = configureVault([note], workspaceSeed([
      { noteId: note.noteId, title: note.title, path: note.path, cursorOffset: null, sourceMode: false },
    ], note.noteId));
    const { app, root } = mountApp();
    await app.boot();
    api.bootstrap.mockRejectedValueOnce(new Error("offline"));
    await expect(app.boot("vault-2")).rejects.toThrow("offline");
    expect(root.textContent).toContain("One");
    expect(oldClient.connectEvents).toHaveBeenCalledTimes(2);
  });

  it("discards a pending old-vault cache read after switching vaults", async () => {
    const first = noteMeta("first", "first.md", "First");
    const second = noteMeta("second", "second.md", "Second");
    const oldClient = configureVault([first], workspaceSeed([
      { noteId: first.noteId, title: first.title, path: first.path, cursorOffset: null, sourceMode: false },
    ], first.noteId));
    const newClient = configureVault([second], workspaceSeed([
      { noteId: second.noteId, title: second.title, path: second.path, cursorOffset: null, sourceMode: false },
    ], second.noteId), "vault-2");
    const services = createServices();
    const pendingCache = deferred<Awaited<ReturnType<typeof services.workspace.getCachedNoteBody>>>();
    const cachedBodyRead = vi.spyOn(services.workspace, "getCachedNoteBody").mockReturnValueOnce(pendingCache.promise);
    const root = document.createElement("div");
    document.body.append(root);
    const app = new TansuApp(root, services);
    const oldBoot = app.boot();
    await until(() => cachedBodyRead.mock.calls.length === 1);
    expect(oldClient.openNote).not.toHaveBeenCalled();
    await app.boot("vault-2");
    expect(newClient.openNote).toHaveBeenCalledWith(second.noteId);
    pendingCache.resolve({
      formatVersion: 2,
      serverInstanceId: "server-1",
      vaultId: DEFAULT_VAULT,
      noteId: first.noteId,
      sourceHash: first.sourceHash,
      content: "# Old cached\n",
      cachedAtMs: 1,
    });
    await oldBoot;
    expect(oldClient.openNote).not.toHaveBeenCalled();
    expect(editorMock.instances[0]?.getSnapshot()?.noteId).toBe("saved:second");
    expect(editorMock.instances[0]?.getSnapshot()?.source).toBe("# Second\n");
    await app.dispose();
  });

  it("keeps one editor mounted and restores a tab's selection, scroll, and source mode", async () => {
    const first = noteMeta("one", "one.md", "One");
    const second = noteMeta("two", "two.md", "Two");
    const client = configureVault([first, second], workspaceSeed([
      { noteId: first.noteId, title: first.title, path: first.path, cursorOffset: null, sourceMode: false },
      { noteId: second.noteId, title: second.title, path: second.path, cursorOffset: null, sourceMode: false },
    ], first.noteId));
    client.openNote.mockImplementation(async (id) => documentFor(id === first.noteId ? first : second, `# ${id}\n`));
    const { app, root } = mountApp();
    await app.boot();
    const editor = editorMock.instances[0]!;
    const firstSession = editor.snapshots.keys().next().value as EditorSession;
    editor.snapshots.set(firstSession, {
      ...editor.getSnapshot()!,
      selection: { anchor: 4, head: 5 },
      scroll: { top: 110, left: 3 },
      mode: "source",
    });
    root.querySelector<HTMLButtonElement>('[title="Two"]')?.click();
    await until(() => root.querySelector<HTMLButtonElement>('.tab.active')?.textContent?.includes("Two") === true && editor.snapshots.size === 2);
    expect(editorMock.instances).toHaveLength(1);
    expect(editor.createSession).toHaveBeenCalledTimes(2);
    root.querySelector<HTMLButtonElement>('[title="One"]')?.click();
    await flushAsync();
    expect(editor.getSnapshot()).toMatchObject({ selection: { anchor: 4, head: 5 }, scroll: { top: 110, left: 3 }, mode: "source" });
    expect(editor.attachSession).toHaveBeenLastCalledWith(firstSession);
  });

  it("preserves shell regions, keyed tabs, and the editor node across title and status updates", async () => {
    const note = noteMeta("note-1", "one.md", "One");
    const renamed = noteMeta(note.noteId, "renamed.md", "Renamed", [], 2, HASH_B);
    const client = configureVault([note], workspaceSeed([
      { noteId: note.noteId, title: note.title, path: note.path, cursorOffset: null, sourceMode: false },
    ], note.noteId));
    client.openNote.mockResolvedValue(documentFor(note, "# One\n"));
    client.renameNote.mockResolvedValue(accepted("rename", renamed));
    const { app, root } = mountApp();
    await app.boot();
    const regions = [...root.children];
    const tab = root.querySelector<HTMLButtonElement>(".tab.active")!;
    const editorMount = root.querySelector("#editor-mount");
    const status = root.querySelector(".statusbar");
    editorMock.instances[0]!.simulateEdit("# Changed\n");
    expect(root.querySelector(".statusbar")?.textContent).toContain("Unsaved");

    await (editorMock.instances[0]!.config["onNoteTitleCommit"] as (request: { title: string; intent: "rename" }) => Promise<boolean>)({ title: "Renamed", intent: "rename" });
    await flushAsync();
    await openSearch(root);

    expect([...root.children]).toStrictEqual(regions);
    expect(root.querySelector("#editor-mount")).toBe(editorMount);
    expect(root.querySelector(".statusbar")).toBe(status);
    expect(root.querySelector<HTMLButtonElement>(".tab.active")).toBe(tab);
    expect(tab.textContent).toContain("Renamed");
  });

  it("autosaves the tab that scheduled a save after switching to another tab", async () => {
    useFakeTimers();
    const first = noteMeta("one", "one.md", "One");
    const second = noteMeta("two", "two.md", "Two");
    const client = configureVault([first, second], workspaceSeed([
      { noteId: first.noteId, title: first.title, path: first.path, cursorOffset: null, sourceMode: false },
      { noteId: second.noteId, title: second.title, path: second.path, cursorOffset: null, sourceMode: false },
    ], first.noteId));
    client.openNote.mockImplementation(async (id) => documentFor(id === first.noteId ? first : second, `# ${id}\n`));
    const saved = deferred<V2MutationResponse>();
    client.saveNote.mockReturnValue(saved.promise);
    const { app, root } = mountApp();
    await app.boot();
    const editor = editorMock.instances[0]!;
    editor.simulateEdit("# Changed first\n");
    root.querySelector<HTMLButtonElement>('[title="Two"]')?.click();
    await flushAsync();
    await vi.advanceTimersByTimeAsync(900);
    await flushAsync();
    expect(client.saveNote).toHaveBeenCalledTimes(1);
    expect(client.saveNote.mock.calls[0]?.[0]).toBe(first.noteId);
    expect(client.saveNote.mock.calls[0]?.[1]).toMatchObject({ content: "# Changed first\n", precondition: { baseRevision: 1, baseSourceHash: HASH_A, baseDiskHash: DISK_HASH } });
    const request = client.saveNote.mock.calls[0]![1];
    saved.resolve(accepted(request.mutationId, noteMeta(first.noteId, first.path, first.title, [], 2, request.sourceHash)));
    await flushAsync();
    editor.simulateEdit("# Changed second\n");
    await vi.advanceTimersByTimeAsync(150);
    await vi.advanceTimersByTimeAsync(900);
    await flushAsync();
    expect(client.saveNote).toHaveBeenCalledTimes(2);
    expect(client.saveNote.mock.calls[1]?.[0]).toBe(second.noteId);
  });

  it("flushes outgoing workspace state and cancels old vault autosaves before switching", async () => {
    useFakeTimers();
    const first = noteMeta("first", "first.md", "First");
    const second = noteMeta("second", "second.md", "Second");
    const oldClient = configureVault([first], workspaceSeed([
      { noteId: first.noteId, title: first.title, path: first.path, cursorOffset: null, sourceMode: false },
    ], first.noteId));
    const newClient = configureVault([second], workspaceSeed([
      { noteId: second.noteId, title: second.title, path: second.path, cursorOffset: null, sourceMode: false },
    ], second.noteId), "vault-2");
    const { app } = mountApp();
    await app.boot();
    editorMock.instances[0]!.simulateEdit("# Outgoing draft\n");
    await app.boot("vault-2");
    await vi.advanceTimersByTimeAsync(1000);
    await flushAsync();

    expect((await storedWorkspace())?.tabs).toMatchObject([
      expect.objectContaining({ kind: "saved", noteId: first.noteId }),
    ]);
    expect(newClient.saveNote).not.toHaveBeenCalled();
    expect(oldClient.saveNote).not.toHaveBeenCalled();
  });

  it("waits for an outgoing save completion before committing the next vault", async () => {
    const oldNote = noteMeta("shared", "old.md", "Old");
    const newNote = noteMeta("shared", "new.md", "New", [], 1, HASH_B);
    const oldClient = configureVault([oldNote], workspaceSeed([
      { noteId: oldNote.noteId, title: oldNote.title, path: oldNote.path, cursorOffset: null, sourceMode: false },
    ], oldNote.noteId));
    const newClient = configureVault([newNote], workspaceSeed([
      { noteId: newNote.noteId, title: newNote.title, path: newNote.path, cursorOffset: null, sourceMode: false },
    ], newNote.noteId), "vault-2");
    const save = deferred<V2MutationResponse>();
    oldClient.saveNote.mockReturnValue(save.promise);
    const { app, root } = mountApp();
    await app.boot();
    const editor = editorMock.instances[0]!;
    const outgoingEditorSession = editor.attachedSession;
    editorMock.instances[0]!.simulateEdit("# Outgoing edit\n");
    await runCommand(root, "save");
    await until(() => oldClient.saveNote.mock.calls.length === 1);
    const switching = app.boot("vault-2");
    let switched = false;
    void switching.then(() => { switched = true; });
    await flushAsync();
    expect(switched).toBeFalsy();
    expect(newClient.saveNote).not.toHaveBeenCalled();

    const request = oldClient.saveNote.mock.calls[0]![1];
    save.resolve(accepted(request.mutationId, noteMeta(oldNote.noteId, oldNote.path, oldNote.title, [], 2, request.sourceHash)));
    await switching;

    expect(root.textContent).toContain("New");
    expect(root.textContent).not.toContain("Old");
    expect(newClient.saveNote).not.toHaveBeenCalled();
    expect(editor.attachedSession).not.toBe(outgoingEditorSession);
    expect(editor.getSnapshot()).toMatchObject({ noteId: "saved:shared", source: "# New\n" });
  });

  it("serializes saves and coalesces edits made while a save is in flight", async () => {
    useFakeTimers();
    const note = noteMeta("note-1", "one.md", "One");
    const client = configureVault([note], workspaceSeed([
      { noteId: note.noteId, title: note.title, path: note.path, cursorOffset: null, sourceMode: false },
    ], note.noteId));
    client.openNote.mockResolvedValue(documentFor(note, "# One\n"));
    const first = deferred<V2MutationResponse>();
    client.saveNote.mockReturnValueOnce(first.promise).mockImplementationOnce(async (_id, request) =>
      accepted(request.mutationId, noteMeta(note.noteId, note.path, note.title, [], 3, HASH_B))
    );
    const { app } = mountApp();
    await app.boot();
    const editor = editorMock.instances[0]!;
    editor.simulateEdit("# First\n");
    await vi.advanceTimersByTimeAsync(150);
    await vi.advanceTimersByTimeAsync(900);
    await flushAsync();
    expect(client.saveNote).toHaveBeenCalledTimes(1);
    editor.simulateEdit("# Second\n");
    await vi.advanceTimersByTimeAsync(150);
    await vi.advanceTimersByTimeAsync(900);
    const firstRequest = client.saveNote.mock.calls[0]![1];
    first.resolve(accepted(firstRequest.mutationId, noteMeta(note.noteId, note.path, note.title, [], 2, firstRequest.sourceHash)));
    await until(() => client.saveNote.mock.calls.length === 2);
    expect(client.saveNote).toHaveBeenCalledTimes(2);
    expect(client.saveNote.mock.calls[1]?.[1]).toMatchObject({ content: "# Second\n", precondition: { baseRevision: 2 } });
  });

  it("captures editor source after a debounce instead of on each change callback", async () => {
    useFakeTimers();
    const note = noteMeta("note-1", "one.md", "One");
    const client = configureVault([note], workspaceSeed([
      { noteId: note.noteId, title: note.title, path: note.path, cursorOffset: null, sourceMode: false },
    ], note.noteId));
    client.openNote.mockResolvedValue(documentFor(note, "# One\n"));
    const { app } = mountApp();
    await app.boot();
    const editor = editorMock.instances[0]!;
    const getSnapshot = editor.getSnapshot as ReturnType<typeof vi.fn>;
    getSnapshot.mockClear();

    editor.simulateEdit("# Changed\n");

    expect(getSnapshot).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(149);
    expect(getSnapshot).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(getSnapshot).toHaveBeenCalled();
  });

  it("caches the canonical document returned by a successful save", async () => {
    const note = noteMeta("note-1", "one.md", "One");
    const client = configureVault([note], workspaceSeed([
      { noteId: note.noteId, title: note.title, path: note.path, cursorOffset: null, sourceMode: false },
    ], note.noteId));
    client.openNote.mockResolvedValue(documentFor(note, "# One\n"));
    client.saveNote.mockImplementation(async (_id, request) =>
      accepted(request.mutationId, noteMeta(note.noteId, note.path, note.title, [], 2, request.sourceHash))
    );
    const { app, root } = mountApp();
    await app.boot();
    await deleteCachedNoteBodies(documentIdentity(note.noteId));
    editorMock.instances[0]!.simulateEdit("# Saved\n");
    await runCommand(root, "save");
    const request = client.saveNote.mock.calls[0]![1];
    await until(async () => (await cachedBody({ noteId: note.noteId, sourceHash: request.sourceHash }))?.content === "# Saved\n");
    expect(await cachedBody({ noteId: note.noteId, sourceHash: request.sourceHash })).toMatchObject({ sourceHash: request.sourceHash, content: "# Saved\n" });
  });

  it("promotes a typed new note on autosave with a title from its first line and never creates an empty one", async () => {
    useFakeTimers();
    const client = configureVault([]);
    const created = noteMeta("created", "plan-for-may.md", "Plan for May");
    client.createNote.mockImplementation(async (request) => accepted(request.mutationId, created));
    client.openNote.mockResolvedValue(documentFor(created, "## Plan for May\n"));
    const { app, root } = mountApp();
    await app.boot();
    root.querySelector<HTMLButtonElement>('[title="New note"]')?.click();
    await until(() => editorMock.instances.length > 0);
    await flushAsync();
    expect(client.createNote).not.toHaveBeenCalled();

    editorMock.instances[0]!.simulateEdit("## Plan for May\n");
    await vi.advanceTimersByTimeAsync(2000);
    await until(() => client.createNote.mock.calls.length === 1);
    expect(client.createNote).toHaveBeenCalledTimes(1);
    expect(client.createNote.mock.calls[0]![0]).toMatchObject({ path: "plan-for-may.md", content: "## Plan for May\n" });
    expect(root.querySelector(".note-dialog-panel")).toBeNull();
  });

  it("keeps a local draft identity and mutation stable until V2 create is accepted", async () => {
    const client = configureVault([]);
    const created = noteMeta("created", "meeting-notes.md", "Meeting Notes");
    const pending = deferred<V2MutationResponse>();
    client.createNote.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(accepted("retry", created));
    client.openNote.mockResolvedValue(documentFor(created, ""));
    const { app, root } = mountApp();
    app.bindGlobalEvents();
    await app.boot();
    root.querySelector<HTMLButtonElement>('[title="New note"]')?.click();
    await until(() => editorMock.instances.length > 0);
    editorMock.instances[0]!.simulateEdit("# Meeting Notes\n");
    await flushEditorCapture();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "s", ctrlKey: true, cancelable: true }));
    await until(() => client.createNote.mock.calls.length === 1);
    const request = client.createNote.mock.calls[0]![0];
    expect(request).toMatchObject({ path: "meeting-notes.md", content: "# Meeting Notes\n", sourceHash: expect.stringMatching(/^blake3-v3:/) });
    pending.resolve({ mutationId: request.mutationId, outcome: { state: "pendingMaterialization", operationId: "op-1" } });
    await flushAsync();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "s", ctrlKey: true, cancelable: true }));
    await flushAsync();
    expect(client.createNote).toHaveBeenCalledTimes(2);
    expect(client.createNote.mock.calls[1]?.[0].mutationId).toBe(request.mutationId);
    const localId = localIdFrom(editorMock.instances[0]!);
    const checkpoint = await savedCheckpoint(created.noteId);
    expect(checkpoint?.noteId).toBe(created.noteId);
    expect(localId).not.toBe(created.noteId);
    expect(await localCheckpoint(localId)).toBeNull();
  });

  it("does not schedule workspace persistence when a local checkpoint read finishes after dispose", async () => {
    useFakeTimers();
    configureVault([]);
    const services = createServices();
    const checkpoint = deferred<LocalDraftJournalRecord | null>();
    const read = vi.spyOn(services.workspace, "getLocalDraftCheckpoint").mockReturnValue(checkpoint.promise);
    const root = document.createElement("div");
    document.body.append(root);
    const app = new TansuApp(root, services);
    apps.push(app);
    await app.boot();

    const workspaceWritesBeforeOpen = memory.workspaceWrites.length;
    root.querySelector<HTMLButtonElement>('[title="New note"]')?.click();
    await until(() => read.mock.calls.length === 1);
    await app.dispose();
    checkpoint.resolve(null);
    await flushAsync();

    expect(vi.getTimerCount()).toBe(0);
    expect(memory.workspaceWrites.slice(workspaceWritesBeforeOpen)).toHaveLength(0);
  });

  it("sends dirty overlays to V2 search and ignores stale results", async () => {
    const note = noteMeta("note-1", "one.md", "One");
    const other = noteMeta("note-2", "two.md", "Two");
    const client = configureVault([note, other]);
    const oldSearch = deferred<V2SearchResponse>();
    const latest = deferred<V2SearchResponse>();
    client.search.mockReturnValueOnce(oldSearch.promise).mockReturnValueOnce(latest.promise);
    client.openNote.mockResolvedValue(documentFor(note, "# One\n"));
    const { app, root } = mountApp();
    await app.boot();
    await openRecentNote(root);
    await flushAsync();
    editorMock.instances[0]!.simulateEdit("# Edited\n");
    await openSearch(root);
    const search = root.querySelector<HTMLInputElement>(".command-input")!;
    search.value = "alpha";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    search.value = "beta";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await flushAsync();
    expect(client.search.mock.calls[1]?.[0]).toMatchObject({ query: "beta", overlays: [expect.objectContaining({ kind: "saved", noteId: note.noteId, content: "# Edited\n" })] });
    latest.resolve(searchResponse([searchHit(other)]));
    await flushAsync();
    oldSearch.resolve(searchResponse([searchHit(note)]));
    await flushAsync();
    expect(root.textContent).toContain("two.md");
    expect(root.textContent).not.toContain("one.md");
  });

  it("shows skipped draft coverage in note search", async () => {
    const client = configureVault([]);
    const partialCoverage = { status: "partial" as const, skippedNoteCount: 2 };
    client.search.mockResolvedValueOnce(searchResponse([], partialCoverage));
    const { app, root } = mountApp();
    await app.boot();

    await openSearch(root);
    const overlaySearch = root.querySelector<HTMLInputElement>(".search-panel input")!;
    overlaySearch.value = "alpha";
    overlaySearch.dispatchEvent(new Event("input", { bubbles: true }));
    await flushAsync();

    expect(root.querySelector(".search-panel")?.textContent).toContain("Draft search skipped 2 drafts");
  });

  it("shows recent notes first and searches from the first character", async () => {
    const source = "# Cached\n";
    const note = { ...noteMeta("note-1", "folder/one.md", "One"), sourceHash: await canonicalSourceHash(source) };
    const client = configureVault([note, noteMeta("note-2", "two.md", "Two")]);
    const load = deferred<V2NoteDocument>();
    client.openNote.mockReturnValue(load.promise);
    client.search.mockResolvedValue(searchResponse([{ ...searchHit(note), sourceRange: { startUtf16: 2, endUtf16: 8 } }]));
    await storeCachedBody(note, source);
    const { app, root } = mountApp();
    await app.boot();
    await openSearch(root);
    expect(root.querySelector(".recent-search-result .search-result-title")?.textContent).toBe("One");
    const overlay = root.querySelector<HTMLInputElement>(".search-panel .command-input")!;
    overlay.value = "o";
    overlay.dispatchEvent(new Event("input", { bubbles: true }));
    await flushAsync();
    expect(client.search).toHaveBeenCalledTimes(1);
    overlay.value = "one";
    overlay.dispatchEvent(new Event("input", { bubbles: true }));
    await flushAsync();
    expect(client.search).toHaveBeenCalledTimes(2);
    root.querySelector<HTMLButtonElement>(".search-result-row")?.click();
    await until(() => editorMock.instances[0]?.getSnapshot()?.source === "# Cached\n");
    expect(client.openNote).toHaveBeenCalledWith(note.noteId);
    load.resolve(documentFor(note, source));
  });

  it("evicts previews when notes leave the recent-note set", async () => {
    const notes = Array.from({ length: 51 }, (_, index) => {
      const number = String(index + 1).padStart(2, "0");
      return noteMeta(`note-${number}`, `${number}.md`, `Note ${number}`);
    });
    configureVault(notes);
    const { app } = mountApp();
    await app.boot();

    const openNote = (app as unknown as { openNote: (id: string) => Promise<void> }).openNote.bind(app);
    for (const note of notes) await openNote(note.noteId);

    const previews = (app as unknown as { recentPreviews: Map<string, string> }).recentPreviews;
    expect(previews.size).toBe(50);
    expect(previews.has(notes[0]!.noteId)).toBeFalsy();
    expect(previews.has(notes[50]!.noteId)).toBeTruthy();
  });

  it("renames and pins locally, then deletes with a V2 precondition", async () => {
    const note = noteMeta("note-1", "one.md", "One");
    const renamed = noteMeta(note.noteId, "renamed.md", "Renamed", [], 2, HASH_B);
    const client = configureVault([note]);
    client.openNote.mockResolvedValue(documentFor(note, "# One\n"));
    client.renameNote.mockResolvedValue(accepted("rename", renamed));
    client.deleteNote.mockResolvedValue({ mutationId: "delete", outcome: { state: "accepted", result: null } });
    const { app, root } = mountApp();
    await app.boot();
    await openRecentNote(root);
    await flushAsync();
    root.querySelector<HTMLButtonElement>(".tab.active")?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    root.querySelector<HTMLButtonElement>('[title="Pin note"]')?.click();
    await flushAsync();
    expect(root.querySelector(".tab.active")?.textContent).toContain("One");
    await (editorMock.instances[0]!.config["onNoteTitleCommit"] as (request: { title: string; intent: "rename" }) => Promise<boolean>)({ title: "Renamed", intent: "rename" });
    await flushAsync();
    expect(client.renameNote).toHaveBeenCalledWith(note.noteId, expect.objectContaining({ path: "renamed.md", precondition: { baseRevision: 1, baseSourceHash: HASH_A, baseDiskHash: DISK_HASH } }));
    root.querySelector<HTMLButtonElement>(".tab.active")?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    root.querySelector<HTMLButtonElement>('[title="Delete note"]')?.click();
    root.querySelector<HTMLButtonElement>(".note-dialog-panel .danger-button")?.click();
    await flushAsync();
    expect(client.deleteNote).toHaveBeenCalledWith(note.noteId, expect.objectContaining({ precondition: { baseRevision: 2, baseSourceHash: HASH_B, baseDiskHash: DISK_HASH } }));
    expect(root.querySelector(".note-dialog-panel")).toBeNull();
    await until(() => root.querySelector(".tab.active") === null);
  });

  it("reports title-checkpoint cleanup failures after an accepted rename", async () => {
    const note = noteMeta("note-1", "one.md", "One");
    const renamed = noteMeta(note.noteId, "renamed.md", "Renamed", [], 2, HASH_B);
    const client = configureVault([note], workspaceSeed([
      { noteId: note.noteId, title: note.title, path: note.path, cursorOffset: null, sourceMode: false },
    ], note.noteId));
    client.openNote.mockResolvedValue(documentFor(note, "# One\n"));
    client.renameNote.mockResolvedValue(accepted("rename", renamed));
    const clearTitle = vi.spyOn(DraftJournal.prototype, "clearTitleDraftCheckpoint").mockRejectedValueOnce(new Error("storage blocked"));
    const { app, root } = mountApp();
    await app.boot();

    const renamedSuccessfully = await (editorMock.instances[0]!.config["onNoteTitleCommit"] as (request: { title: string; intent: "rename" }) => Promise<boolean>)({ title: "Renamed", intent: "rename" });
    expect(renamedSuccessfully).toBeTruthy();

    expect(client.renameNote).toHaveBeenCalledTimes(1);
    expect(clearTitle).toHaveBeenCalledTimes(1);
    expect(root.querySelector<HTMLButtonElement>(".tab.active")?.title).toBe("Renamed");
    expect((await savedCheckpoint(note.noteId))?.titleDraft).toBe("Renamed");
    clearTitle.mockRestore();
  });

  it("persists and recovers a dirty closed tab through its workspace and journal", async () => {
    useFakeTimers();
    const note = noteMeta("note-1", "one.md", "One");
    const client = configureVault([note], workspaceSeed([
      { noteId: note.noteId, title: note.title, path: note.path, cursorOffset: null, sourceMode: false },
    ], note.noteId));
    client.openNote.mockResolvedValue(documentFor(note, "# One\n"));
    client.saveNote.mockImplementation(async (_id, request) => ({
      mutationId: request.mutationId,
      outcome: { state: "conflict", current: documentFor(noteMeta(note.noteId, note.path, note.title, [], 2, HASH_B), "# Remote\n"), draft: conflictDraft(note.noteId) },
    }));
    const services = createServices();
    const journal = new DraftJournal(() => {});
    const flushAll = vi.spyOn(journal, "flushAll");
    vi.spyOn(services.workspace, "createJournal").mockReturnValue(journal);
    const { app, root } = mountApp(services);
    await app.boot();
    const editor = editorMock.instances[0]!;
    editor.simulateEdit("# Recoverable draft\n");
    await vi.advanceTimersByTimeAsync(150);
    await flushAsync();
    await vi.advanceTimersByTimeAsync(200);
    await flushAsync();
    expect((await savedCheckpoint(note.noteId))?.source).toBe("# Recoverable draft\n");

    root.querySelector<HTMLButtonElement>(".tab.active .tab-close")?.click();
    await until(async () => root.querySelector(".tab") === null && (await storedWorkspace())?.closedTabs.length === 1);
    expect(flushAll).toHaveBeenCalled();
    expect((await storedWorkspace())?.closedTabs[0]).toMatchObject({
      kind: "saved",
      noteId: note.noteId,
    });
    expect((await savedCheckpoint(note.noteId))?.source).toBe("# Recoverable draft\n");

    await app.dispose();
    const { root: reopenedRoot } = mountApp();
    await apps.at(-1)!.boot();
    await runCommand(reopenedRoot, "reopen");
    await until(() => editorMock.instances.at(-1)?.getSnapshot()?.source === "# Recoverable draft\n");
  });

  it("restores a selected revision and refreshes the mounted editor from canonical content", async () => {
    const note = noteMeta("note-1", "one.md", "One");
    const restored = noteMeta(note.noteId, note.path, note.title, [], 2, HASH_B);
    const revision = { noteId: note.noteId, revision: 4, kind: "save" as const, source: "user" as const, sourceHash: HASH_B, createdAtMs: 5 };
    const client = configureVault([note], workspaceSeed([
      { noteId: note.noteId, title: note.title, path: note.path, cursorOffset: null, sourceMode: false },
    ], note.noteId));
    client.openNote.mockResolvedValueOnce(documentFor(note, "# One\n")).mockResolvedValueOnce(documentFor(restored, "# Restored\n"));
    client.listRevisions.mockResolvedValue([revision]);
    client.openRevision.mockResolvedValue({ revision, content: "# Restored\n" });
    client.restoreRevision.mockImplementation(async (_id, _revision, request) => accepted(request.mutationId, restored));
    const { app, root } = mountApp();
    await app.boot();
    editorMock.instances[0]!.simulateEdit("# Local change\n");
    await runCommand(root, "revisions");
    expect(client.listRevisions).toHaveBeenCalledWith(note.noteId);
    root.querySelector<HTMLButtonElement>(".revision-row")?.click();
    await flushAsync();
    root.querySelector<HTMLButtonElement>(".revisions-panel .primary-button")?.click();
    await flushAsync();
    expect(client.restoreRevision).toHaveBeenCalledWith(note.noteId, revision.revision, expect.objectContaining({
      precondition: { baseRevision: 1, baseSourceHash: HASH_A, baseDiskHash: DISK_HASH },
    }));
    expect(editorMock.instances[0]?.getSnapshot()?.source).toBe("# Restored\n");
    expect(root.textContent).not.toContain("Save conflict");
    await until(async () => (await cachedBody(restored))?.content === "# Restored\n");
    expect((await cachedBody(restored))?.content).toBe("# Restored\n");
  });

  it("drops a revision restore that resolves after its tab was closed", async () => {
    const first = noteMeta("first", "first.md", "First");
    const second = noteMeta("second", "second.md", "Second");
    const restored = noteMeta(first.noteId, first.path, first.title, [], 2, HASH_B);
    const revision = { noteId: first.noteId, revision: 4, kind: "save" as const, source: "user" as const, sourceHash: HASH_B, createdAtMs: 5 };
    const client = configureVault([first, second], workspaceSeed([
      { noteId: first.noteId, title: first.title, path: first.path, cursorOffset: null, sourceMode: false },
      { noteId: second.noteId, title: second.title, path: second.path, cursorOffset: null, sourceMode: false },
    ], first.noteId));
    client.listRevisions.mockResolvedValue([revision]);
    client.openRevision.mockResolvedValue({ revision, content: "# Restored\n" });
    const restore = deferred<V2MutationResponse>();
    client.restoreRevision.mockReturnValue(restore.promise);
    const { app, root } = mountApp();
    await app.boot();
    await runCommand(root, "revisions");
    root.querySelector<HTMLButtonElement>(".revision-row")?.click();
    await flushAsync();
    root.querySelector<HTMLButtonElement>(".revisions-panel .primary-button")?.click();
    await until(() => client.restoreRevision.mock.calls.length === 1);
    root.querySelector<HTMLButtonElement>('.tab[title="First"] .tab-close')?.click();
    await flushAsync();
    await until(async () => (await cachedBody(first)) === null);
    const openNoteCallsBeforeRestoreSettles = client.openNote.mock.calls.length;
    client.openNote.mockResolvedValue(documentFor(restored, "# Restored\n"));

    restore.resolve(accepted(client.restoreRevision.mock.calls[0]![2].mutationId, restored));
    await flushAsync();

    expect(client.openNote).toHaveBeenCalledTimes(openNoteCallsBeforeRestoreSettles);
    expect(await cachedBody(first)).toBeNull();
    expect(root.querySelector(".toast")).toBeNull();
  });

  it("holds a vault switch until an in-flight revision restore settles in its own vault", async () => {
    const oldNote = noteMeta("shared", "old.md", "Old");
    const newNote = noteMeta("shared", "new.md", "New", [], 1, `blake3-v3:${"d".repeat(64)}`);
    const restored = noteMeta(oldNote.noteId, oldNote.path, oldNote.title, [], 2, HASH_B);
    const revision = { noteId: oldNote.noteId, revision: 4, kind: "save" as const, source: "user" as const, sourceHash: HASH_B, createdAtMs: 5 };
    const oldClient = configureVault([oldNote], workspaceSeed([
      { noteId: oldNote.noteId, title: oldNote.title, path: oldNote.path, cursorOffset: null, sourceMode: false },
    ], oldNote.noteId));
    const newClient = configureVault([newNote], workspaceSeed([
      { noteId: newNote.noteId, title: newNote.title, path: newNote.path, cursorOffset: null, sourceMode: false },
    ], newNote.noteId), "vault-2");
    oldClient.listRevisions.mockResolvedValue([revision]);
    oldClient.openRevision.mockResolvedValue({ revision, content: "# Restored\n" });
    const restore = deferred<V2MutationResponse>();
    oldClient.restoreRevision.mockReturnValue(restore.promise);
    const { app, root } = mountApp();
    await app.boot();
    await runCommand(root, "revisions");
    root.querySelector<HTMLButtonElement>(".revision-row")?.click();
    await flushAsync();
    root.querySelector<HTMLButtonElement>(".revisions-panel .primary-button")?.click();
    await until(() => oldClient.restoreRevision.mock.calls.length === 1);

    const switching = app.boot("vault-2");
    await flushAsync();
    oldClient.openNote.mockResolvedValue(documentFor(restored, "# Restored\n"));
    restore.resolve(accepted(oldClient.restoreRevision.mock.calls[0]![2].mutationId, restored));
    await switching;

    expect(oldClient.openNote).toHaveBeenCalledTimes(2);
    expect(newClient.openNote).toHaveBeenCalledTimes(1);
    expect(root.textContent).toContain("New");
    expect(editorMock.instances[0]?.getSnapshot()).toMatchObject({ noteId: "saved:shared", source: "# New\n" });
    expect((await cachedBody(oldNote, DEFAULT_VAULT))?.content).not.toBe("# Restored\n");
  });

  it("ignores a revision list that resolves after switching notes", async () => {
    const first = noteMeta("first", "first.md", "First");
    const second = noteMeta("second", "second.md", "Second");
    const revision = { noteId: first.noteId, revision: 4, kind: "save" as const, source: "user" as const, sourceHash: HASH_B, createdAtMs: 5 };
    const client = configureVault([first, second], workspaceSeed([
      { noteId: first.noteId, title: first.title, path: first.path, cursorOffset: null, sourceMode: false },
      { noteId: second.noteId, title: second.title, path: second.path, cursorOffset: null, sourceMode: false },
    ], first.noteId));
    const revisions = deferred<V2RevisionMeta[]>();
    client.listRevisions.mockReturnValue(revisions.promise);
    const { app, root } = mountApp();
    await app.boot();

    await runCommand(root, "revisions");
    await until(() => client.listRevisions.mock.calls.length === 1);
    root.querySelector<HTMLButtonElement>('.tab[title="Second"]')?.click();
    await flushAsync();
    revisions.resolve([revision]);
    await flushAsync();

    expect(root.querySelector('.tab.active')?.getAttribute("title")).toBe("Second");
    expect(root.querySelector(".revision-row")).toBeNull();
  });

  it("ignores a revision preview that resolves after switching notes", async () => {
    const first = noteMeta("first", "first.md", "First");
    const second = noteMeta("second", "second.md", "Second");
    const revision = { noteId: first.noteId, revision: 4, kind: "save" as const, source: "user" as const, sourceHash: HASH_B, createdAtMs: 5 };
    const client = configureVault([first, second], workspaceSeed([
      { noteId: first.noteId, title: first.title, path: first.path, cursorOffset: null, sourceMode: false },
      { noteId: second.noteId, title: second.title, path: second.path, cursorOffset: null, sourceMode: false },
    ], first.noteId));
    client.listRevisions.mockResolvedValue([revision]);
    const preview = deferred<V2RevisionDocument>();
    client.openRevision.mockReturnValue(preview.promise);
    const { app, root } = mountApp();
    await app.boot();

    await runCommand(root, "revisions");
    root.querySelector<HTMLButtonElement>(".revision-row")?.click();
    await until(() => client.openRevision.mock.calls.length === 1);
    root.querySelector<HTMLButtonElement>('.tab[title="Second"]')?.click();
    await flushAsync();
    preview.resolve({ revision, content: "# First revision\n" });
    await flushAsync();
    root.querySelector<HTMLButtonElement>(".revisions-panel .primary-button")?.click();
    await flushAsync();

    expect(root.querySelector('.tab.active')?.getAttribute("title")).toBe("Second");
    expect(root.querySelector(".diff-preview")).toBeNull();
    expect(client.restoreRevision).not.toHaveBeenCalled();
  });

  it("saves a dirty note to the server when its tab is closed", async () => {
    useFakeTimers();
    const note = noteMeta("note-1", "one.md", "One");
    const client = configureVault([note], workspaceSeed([
      { noteId: note.noteId, title: note.title, path: note.path, cursorOffset: null, sourceMode: false },
    ], note.noteId));
    client.openNote.mockResolvedValue(documentFor(note, "# One\n"));
    const { app, root } = mountApp();
    await app.boot();
    editorMock.instances[0]!.simulateEdit("# Closed early\n");
    await vi.advanceTimersByTimeAsync(150);
    await flushAsync();

    root.querySelector<HTMLButtonElement>(".tab.active .tab-close")?.click();
    await vi.advanceTimersByTimeAsync(1000);
    await flushAsync();

    expect(root.querySelector(".tab")).toBeNull();
    expect(client.saveNote).toHaveBeenCalledWith(note.noteId, expect.objectContaining({ content: "# Closed early\n" }));
  });

  it("restores a locally detected conflict against the canonical revision", async () => {
    const note = noteMeta("note-1", "one.md", "One");
    const restored = noteMeta(note.noteId, note.path, note.title, [], 3, HASH_B);
    const client = configureVault([note], workspaceSeed([
      { noteId: note.noteId, title: note.title, path: note.path, cursorOffset: 1, sourceMode: false },
    ], note.noteId));
    await storeCachedBody(note, "# Cached\n");
    const load = deferred<V2NoteDocument>();
    client.openNote.mockReturnValueOnce(load.promise).mockResolvedValue(documentFor(restored, "# Local edit\n"));
    client.saveNote.mockImplementation(async (_id, request) => accepted(request.mutationId, restored));
    const { app, root } = mountApp();
    const boot = app.boot();
    await until(() => editorMock.instances[0]?.getSnapshot()?.source === "# Cached\n");
    editorMock.instances[0]!.simulateEdit("# Local edit\n");
    await flushEditorCapture();
    const newer = noteMeta(note.noteId, note.path, note.title, [], 2, HASH_B);
    load.resolve(documentFor(newer, "# Canonical\n"));
    await boot;
    expect(root.textContent).toContain("Save conflict");

    root.querySelector<HTMLButtonElement>('[title="Restore conflict draft"]')?.click();
    await flushAsync();

    expect(client.restoreConflictDraft).not.toHaveBeenCalled();
    expect(client.saveNote).toHaveBeenCalledWith(note.noteId, expect.objectContaining({
      content: "# Local edit\n",
      precondition: { baseRevision: 2, baseSourceHash: HASH_B, baseDiskHash: DISK_HASH },
    }));
    expect(root.textContent).not.toContain("Save conflict");
  });

  it("clears the exact checkpoint and replaces the editor after restoring a conflict draft", async () => {
    const note = noteMeta("note-1", "one.md", "One");
    const remote = noteMeta(note.noteId, note.path, note.title, [], 2, HASH_B);
    const restored = noteMeta(note.noteId, note.path, note.title, [], 3, HASH_B);
    const client = configureVault([note], workspaceSeed([
      { noteId: note.noteId, title: note.title, path: note.path, cursorOffset: null, sourceMode: false },
    ], note.noteId));
    client.openNote.mockResolvedValueOnce(documentFor(note, "# One\n")).mockResolvedValueOnce(documentFor(restored, "# Draft\n"));
    client.saveNote.mockImplementation(async (_id, request) => ({
      mutationId: request.mutationId,
      outcome: { state: "conflict", current: documentFor(remote, "# Remote\n"), draft: conflictDraft(note.noteId) },
    }));
    client.openConflictDraft.mockResolvedValue({ draft: conflictDraft(note.noteId), content: "# Draft\n" });
    client.restoreConflictDraft.mockImplementation(async (_id, _draft, request) => accepted(request.mutationId, restored));
    const { app, root } = mountApp();
    await app.boot();
    editorMock.instances[0]!.simulateEdit("# Draft\n");
    await runCommand(root, "save");
    await until(() => root.textContent?.includes("Save conflict") === true);
    root.querySelector<HTMLButtonElement>('[title="View conflict draft"]')?.click();
    await flushAsync();
    expect(client.openConflictDraft).toHaveBeenCalledWith(note.noteId, 9);
    root.querySelector<HTMLButtonElement>('[title="Restore conflict draft"]')?.click();
    await flushAsync();
    expect(client.restoreConflictDraft).toHaveBeenCalledWith(note.noteId, 9, expect.objectContaining({
      precondition: { baseRevision: 2, baseSourceHash: HASH_B, baseDiskHash: DISK_HASH },
    }));
    expect(editorMock.instances[0]?.getSnapshot()?.source).toBe("# Draft\n");
    expect(root.textContent).not.toContain("Save conflict");
    expect(await savedCheckpoint(note.noteId)).toBeNull();
  });

  it("clamps settings and retains non-finite values", async () => {
    const note = noteMeta("note-1", "one.md", "One", ["alpha"]);
    const client = configureVault([note], workspaceSeed([
      { noteId: note.noteId, title: note.title, path: note.path, cursorOffset: null, sourceMode: false },
    ], note.noteId));
    const { app, root } = mountApp();
    await app.boot();
    await runCommand(root, "settings");
    root.querySelector<HTMLInputElement>('input[title="Autosave delay"]')!.value = "10";
    root.querySelector<HTMLInputElement>('input[title="Undo stack"]')!.value = "1";
    root.querySelector<HTMLInputElement>('input[title="Image quality"]')!.value = "2";
    root.querySelector<HTMLButtonElement>(".settings-panel .primary-button")?.click();
    await flushAsync();
    expect(client.saveSettings.mock.calls[0]?.[0].settings).toMatchObject({ autosaveDelayMs: 150, undoStackMax: 20, imageWebpQuality: 1 });
    await runCommand(root, "settings");
    root.querySelector<HTMLInputElement>('input[title="Autosave delay"]')!.value = "Infinity";
    root.querySelector<HTMLInputElement>('input[title="Undo stack"]')!.value = "Infinity";
    root.querySelector<HTMLInputElement>('input[title="Image quality"]')!.value = "Infinity";
    root.querySelector<HTMLButtonElement>(".settings-panel .primary-button")?.click();
    await flushAsync();
    expect(client.saveSettings.mock.calls[1]?.[0].settings).toMatchObject({ autosaveDelayMs: 150, undoStackMax: 20, imageWebpQuality: 1 });
  });

  it("clamps settings to the server's upper bounds before saving", async () => {
    const note = noteMeta("note-1", "one.md", "One");
    const client = configureVault([note], workspaceSeed([
      { noteId: note.noteId, title: note.title, path: note.path, cursorOffset: null, sourceMode: false },
    ], note.noteId));
    const { app, root } = mountApp();
    await app.boot();
    await runCommand(root, "settings");
    root.querySelector<HTMLInputElement>('input[title="Autosave delay"]')!.value = "999999999";
    root.querySelector<HTMLInputElement>('input[title="Undo stack"]')!.value = "999999";
    root.querySelector<HTMLButtonElement>(".settings-panel .primary-button")?.click();
    await flushAsync();
    expect(client.saveSettings.mock.calls[0]?.[0].settings).toMatchObject({ autosaveDelayMs: 3_600_000, undoStackMax: 10_000 });
  });

  it("does not save settings with an invalid excluded folder", async () => {
    const note = noteMeta("note-1", "one.md", "One");
    const client = configureVault([note], workspaceSeed([
      { noteId: note.noteId, title: note.title, path: note.path, cursorOffset: null, sourceMode: false },
    ], note.noteId));
    const { app, root } = mountApp();
    await app.boot();
    await runCommand(root, "settings");
    root.querySelector<HTMLInputElement>('input[title="Excluded folders"]')!.value = "docs/private";
    root.querySelector<HTMLButtonElement>(".settings-panel .primary-button")?.click();
    await flushAsync();
    expect(client.saveSettings).not.toHaveBeenCalled();
    expect(root.querySelector(".settings-panel .settings-error")?.textContent).toMatch(/single folder name/);
  });

  it("gives the editor the booted and the saved undo depth and image quality", async () => {
    const note = noteMeta("note-1", "one.md", "One");
    const client = configureVault([note], workspaceSeed([
      { noteId: note.noteId, title: note.title, path: note.path, cursorOffset: null, sourceMode: false },
    ], note.noteId));
    const { app, root } = mountApp();
    await app.boot();
    expect(editorMock.instances[0]?.config).toMatchObject({ undoStackMax: 100, imageWebpQuality: 0.8 });

    await runCommand(root, "settings");
    root.querySelector<HTMLInputElement>('input[title="Undo stack"]')!.value = "60";
    root.querySelector<HTMLInputElement>('input[title="Image quality"]')!.value = "0.5";
    root.querySelector<HTMLButtonElement>(".settings-panel .primary-button")?.click();
    await flushAsync();

    expect(client.saveSettings.mock.calls[0]?.[0].settings).toMatchObject({ undoStackMax: 60, imageWebpQuality: 0.5 });
    expect(editorMock.instances[0]?.config).toMatchObject({ undoStackMax: 60, imageWebpQuality: 0.5 });
  });

  it("limits the production editor undo history after settings are saved without losing the document", async () => {
    const note = noteMeta("note-1", "one.md", "One");
    const client = configureVault([note], workspaceSeed([
      { noteId: note.noteId, title: note.title, path: note.path, cursorOffset: null, sourceMode: false },
    ], note.noteId));
    client.openNote.mockResolvedValue(documentFor(note, "# One\n"));
    const { app, root } = mountApp({ ...createServices(), editor: { createEditor: createCodeMirrorEditor } });
    await app.boot();
    await until(() => root.querySelector(".cm-content")?.textContent?.includes("One") === true);
    const view = EditorView.findFromDOM(root.querySelector<HTMLElement>(".cm-editor")!)!;
    const typeIsolated = (count: number) => {
      for (let index = 0; index < count; index += 1) {
        view.dispatch({ changes: { from: view.state.doc.length, insert: "x" }, annotations: isolateHistory.of("full") });
      }
    };
    typeIsolated(60);

    await runCommand(root, "settings");
    root.querySelector<HTMLInputElement>('input[title="Undo stack"]')!.value = "20";
    root.querySelector<HTMLButtonElement>(".settings-panel .primary-button")?.click();
    await flushAsync();
    expect(view.state.doc.toString()).toBe(`${"# One\n"}${"x".repeat(60)}`);
    typeIsolated(240);

    const typed = view.state.doc.length;
    let undone = 0;
    while (undo(view)) undone += 1;
    expect(typed).toBe("# One\n".length + 300);
    expect(undone).toBeGreaterThanOrEqual(20);
    expect(undone).toBeLessThanOrEqual(40);
    expect(view.state.doc).toHaveLength(typed - undone);
  });

  it("reopens an imported closed tab with its saved source mode after close", async () => {
    const active = noteMeta("active", "active.md", "Active");
    const closed = noteMeta("closed", "closed.md", "Closed");
    const client = configureVault([active, closed], workspaceSeed([], null, [
      { noteId: closed.noteId, title: closed.title, path: closed.path, cursorOffset: 3, sourceMode: true },
    ]));
    client.openNote.mockImplementation(async (id) => documentFor(id === active.noteId ? active : closed, `# ${id}\n`));
    const { app, root } = mountApp();
    await app.boot();
    await runCommand(root, "reopen");
    await until(() => editorMock.instances[0]?.getSnapshot()?.noteId === "saved:closed");
    expect(editorMock.instances[0]?.getSnapshot()?.mode).toBe("source");
    expect(client.openNote).toHaveBeenCalledWith(closed.noteId);
  });

  it("creates an extension-imported note through a V2 local draft and preserves source mode", async () => {
    const note = noteMeta("note-1", "one.md", "One");
    const imported = noteMeta("imported", "imported.md", "Imported");
    const client = configureVault([note]);
    client.createNote.mockImplementation(async (request) => accepted(request.mutationId, imported));
    client.openNote.mockImplementation(async (id) => id === imported.noteId
      ? documentFor(imported, "# Imported\n")
      : documentFor(note, "# One\n"));
    const { app, root } = mountApp();
    app.bindGlobalEvents();
    await app.boot();
    sendImport();
    await until(() => client.createNote.mock.calls.length === 1);
    expect(client.createNote.mock.calls[0]?.[0]).toMatchObject({ path: "imported.md", content: "# Imported\n" });
    await until(() => root.querySelector<HTMLButtonElement>('.tab.active')?.title === "Imported");
    const editor = editorMock.instances[0]!;
    await runCommand(root, "source");
    expect(editor.setMode).toHaveBeenCalledWith("source");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "n", metaKey: true, altKey: true }));
    await until(() => root.querySelectorAll(".tab").length === 2);
    expect(root.querySelector(".note-dialog-panel")).toBeNull();
  });

  it("keeps the user's selected tab when an import finishes creating its note", async () => {
    const note = noteMeta("note-1", "one.md", "One");
    const imported = noteMeta("imported", "imported.md", "Imported");
    const client = configureVault([note], workspaceSeed([
      { noteId: note.noteId, title: note.title, path: note.path, cursorOffset: null, sourceMode: false },
    ], note.noteId));
    const created = deferred<V2MutationResponse>();
    client.createNote.mockReturnValue(created.promise);
    client.openNote.mockImplementation(async (id) => id === imported.noteId
      ? documentFor(imported, "# Imported\n")
      : documentFor(note, "# One\n"));
    const { app, root } = mountApp();
    await app.boot();
    sendImport();
    await until(() => client.createNote.mock.calls.length === 1);
    root.querySelector<HTMLButtonElement>('.tab[title="One"]')?.click();
    await flushAsync();

    created.resolve(accepted(client.createNote.mock.calls[0]![0].mutationId, imported));
    await until(() => root.querySelector('.tab[title="Imported"]') !== null);

    expect(root.querySelector(".tab.active")?.getAttribute("title")).toBe("One");
  });

  it("does not select a note whose import draft tab was closed while it was being created", async () => {
    const note = noteMeta("note-1", "one.md", "One");
    const imported = noteMeta("imported", "imported.md", "Imported");
    const client = configureVault([note], workspaceSeed([
      { noteId: note.noteId, title: note.title, path: note.path, cursorOffset: null, sourceMode: false },
    ], note.noteId));
    const created = deferred<V2MutationResponse>();
    client.createNote.mockReturnValue(created.promise);
    client.openNote.mockImplementation(async (id) => id === imported.noteId
      ? documentFor(imported, "# Imported\n")
      : documentFor(note, "# One\n"));
    const { app, root } = mountApp();
    await app.boot();
    sendImport();
    await until(() => client.createNote.mock.calls.length === 1);
    root.querySelector<HTMLButtonElement>('.tab.active .tab-close')?.click();
    await flushAsync();
    expect(root.querySelector(".tab.active")?.getAttribute("title")).toBe("One");

    created.resolve(accepted(client.createNote.mock.calls[0]![0].mutationId, imported));
    await until(() => client.openNote.mock.calls.some((call) => call[0] === imported.noteId));
    await flushAsync();

    expect(root.querySelector(".tab.active")?.getAttribute("title")).toBe("One");
    expect(root.querySelector('.tab[title="Imported"]')).toBeNull();
  });

  it("drops a conflict draft preview that resolves after switching notes", async () => {
    const first = noteMeta("first", "first.md", "First");
    const second = noteMeta("second", "second.md", "Second");
    const remote = noteMeta(first.noteId, first.path, first.title, [], 2, HASH_B);
    const client = configureVault([first, second], workspaceSeed([
      { noteId: first.noteId, title: first.title, path: first.path, cursorOffset: null, sourceMode: false },
      { noteId: second.noteId, title: second.title, path: second.path, cursorOffset: null, sourceMode: false },
    ], first.noteId));
    client.saveNote.mockImplementation(async (_id, request) => ({
      mutationId: request.mutationId,
      outcome: { state: "conflict", current: documentFor(remote, "# Remote\n"), draft: conflictDraft(first.noteId) },
    }));
    const preview = deferred<V2ConflictDraftDocument>();
    client.openConflictDraft.mockReturnValue(preview.promise);
    const { app, root } = mountApp();
    await app.boot();
    editorMock.instances[0]!.simulateEdit("# Draft\n");
    await runCommand(root, "save");
    await until(() => root.textContent?.includes("Save conflict") === true);
    root.querySelector<HTMLButtonElement>('[title="View conflict draft"]')?.click();
    await until(() => client.openConflictDraft.mock.calls.length === 1);
    root.querySelector<HTMLButtonElement>('.tab[title="Second"]')?.click();
    await flushAsync();

    preview.resolve({ draft: conflictDraft(first.noteId), content: "# Draft\n" });
    await flushAsync();

    expect(root.querySelector(".tab.active")?.getAttribute("title")).toBe("Second");
    expect(root.querySelector('[data-key="modal:conflict"]')).toBeNull();
  });

  it("routes note image loads through the active vault and revokes object URLs on dispose", async () => {
    const note = noteMeta("note-1", "one.md", "One");
    const client = configureVault([note], workspaceSeed([
      { noteId: note.noteId, title: note.title, path: note.path, cursorOffset: null, sourceMode: false },
    ], note.noteId));
    client.openNote.mockResolvedValue(documentFor(note, "![[z-images/photo.webp|132]]\n"));
    const createUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:image");
    const revokeUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const { app } = mountApp();
    await app.boot();
    await until(() => client.loadAsset.mock.calls.length === 1);
    expect(client.loadAsset).toHaveBeenCalledWith("z-images/photo.webp", expect.any(AbortSignal));
    expect(createUrl).toHaveBeenCalledWith(expect.any(Blob));
    await app.dispose();
    expect(revokeUrl).toHaveBeenCalledWith("blob:image");
  });

  it("loads note images with bounded concurrency and one reconfiguration per batch", async () => {
    const note = noteMeta("note-1", "one.md", "One");
    const client = configureVault([note], workspaceSeed([
      { noteId: note.noteId, title: note.title, path: note.path, cursorOffset: null, sourceMode: false },
    ], note.noteId));
    const imageCount = 12;
    client.openNote.mockResolvedValue(documentFor(note, `${Array.from({ length: imageCount }, (_, index) => `![[z-images/p${index}.webp]]`).join("\n")}\n`));
    let inFlight = 0;
    let maxInFlight = 0;
    client.loadAsset.mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await flushAsync();
      inFlight -= 1;
      return new Blob(["image"], { type: "image/webp" });
    });
    let urlSequence = 0;
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:image-${++urlSequence}`);
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const { app } = mountApp();
    await app.boot();
    const editor = editorMock.instances[0]!;
    const before = vi.mocked(editor.updateConfiguration).mock.calls.length;
    await until(() => urlSequence === imageCount);
    await flushAsync();
    expect(client.loadAsset).toHaveBeenCalledTimes(imageCount);
    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(4);
    expect(vi.mocked(editor.updateConfiguration).mock.calls.length - before).toBeLessThanOrEqual(Math.ceil(imageCount / 4));
  });

  it("revokes every created image URL on dispose", async () => {
    const note = noteMeta("note-1", "one.md", "One");
    const client = configureVault([note], workspaceSeed([
      { noteId: note.noteId, title: note.title, path: note.path, cursorOffset: null, sourceMode: false },
    ], note.noteId));
    client.openNote.mockResolvedValue(documentFor(note, "![[z-images/a.webp]]\n![[z-images/b.webp]]\n![[z-images/c.webp]]\n"));
    const created: string[] = [];
    const revoked: string[] = [];
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => {
      const url = `blob:image-${created.length}`;
      created.push(url);
      return url;
    });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation((url) => { revoked.push(url); });
    const { app } = mountApp();
    await app.boot();
    await until(() => created.length === 3);
    await flushAsync();
    await app.dispose();
    expect(revoked.toSorted()).toStrictEqual([...created].toSorted());
  });

  it("uploads pasted images through the current vault and reports status", async () => {
    const note = noteMeta("note-1", "one.md", "One");
    const client = configureVault([note], workspaceSeed([
      { noteId: note.noteId, title: note.title, path: note.path, cursorOffset: null, sourceMode: false },
    ], note.noteId));
    const image = new Blob(["webp"], { type: "image/webp" });
    const { app, root } = mountApp();
    await app.boot();
    const editor = editorMock.instances[0]!;
    const upload = editor.config["uploadPastedImage"] as NonNullable<EditorConfig["uploadPastedImage"]>;
    const onState = editor.config["onImagePasteStateChange"] as NonNullable<EditorConfig["onImagePasteStateChange"]>;
    const signal = new AbortController().signal;

    await expect(upload({
      image,
      noteId: note.noteId,
      revision: 0,
      selection: { anchor: 0, head: 0 },
      signal,
    })).resolves.toMatchObject({ name: "z-images/a.webp", markdown: "![[a.webp]]" });
    expect(client.uploadImage).toHaveBeenCalledWith(expect.any(String), image, signal);

    onState({ uploadId: 1, noteId: note.noteId, revision: 0, selection: { anchor: 0, head: 0 }, status: "uploading", previewUrl: "blob:preview" });
    expect(root.querySelector(".image-upload-status")?.textContent).toContain("Uploading image");
    onState({ uploadId: 1, noteId: note.noteId, revision: 0, selection: { anchor: 0, head: 0 }, status: "failed", message: "offline" });
    expect(root.querySelector(".toast")?.textContent).toContain("Image upload failed: offline");
    expect(root.querySelector(".image-upload-status")).toBeNull();
  });

  it("autosaves image insertion when upload status rerenders the shell", async () => {
    useFakeTimers();
    const note = noteMeta("note-1", "one.md", "One");
    const client = configureVault([note], workspaceSeed([
      { noteId: note.noteId, title: note.title, path: note.path, cursorOffset: null, sourceMode: false },
    ], note.noteId));
    const { app } = mountApp();
    await app.boot();
    await flushAsync();
    await vi.advanceTimersByTimeAsync(250);
    await flushAsync();

    const editor = editorMock.instances[0]!;
    const onState = editor.config["onImagePasteStateChange"] as NonNullable<EditorConfig["onImagePasteStateChange"]>;
    const paste = {
      uploadId: 1,
      noteId: note.noteId,
      revision: 0,
      selection: { anchor: 0, head: 0 },
    };
    onState({ ...paste, status: "uploading", previewUrl: "blob:preview" });
    editor.simulateEdit("![[z-images/image.webp]]\n");
    onState({ ...paste, status: "inserted" });
    await vi.advanceTimersByTimeAsync(900);
    await flushAsync();

    expect(client.saveNote).toHaveBeenCalledWith(
      note.noteId,
      expect.objectContaining({ content: "![[z-images/image.webp]]\n" }),
    );
  });

  it("captures a change reported for an inactive note into that note's session", async () => {
    useFakeTimers();
    const first = noteMeta("one", "one.md", "One");
    const second = noteMeta("two", "two.md", "Two");
    const client = configureVault([first, second], workspaceSeed([
      { noteId: first.noteId, title: first.title, path: first.path, cursorOffset: null, sourceMode: false },
      { noteId: second.noteId, title: second.title, path: second.path, cursorOffset: null, sourceMode: false },
    ], first.noteId));
    const saved = deferred<V2MutationResponse>();
    client.saveNote.mockReturnValue(saved.promise);
    const { app, root } = mountApp();
    await app.boot();
    await flushAsync();
    const editor = editorMock.instances[0]!;
    root.querySelector<HTMLButtonElement>('.tab[title="Two"]')?.click();
    await until(() => editor.attachedSession?.noteId === "saved:two");
    expect(editor.attachedSession?.noteId).toBe("saved:two");

    editor.simulateEditIn("saved:one", "![[z-images/a.webp]]\n# One\n");
    await vi.advanceTimersByTimeAsync(150);
    await flushAsync();

    expect(root.querySelector('.tab[title="One"]')?.classList.contains("tab-dirty")).toBeTruthy();
    expect(root.querySelector('.tab[title="Two"]')?.classList.contains("tab-dirty")).toBeFalsy();
    await vi.advanceTimersByTimeAsync(900);
    await flushAsync();
    expect(client.saveNote).toHaveBeenCalledTimes(1);
    expect(client.saveNote.mock.calls[0]?.[0]).toBe(first.noteId);
    expect(client.saveNote.mock.calls[0]?.[1]).toMatchObject({ content: "![[z-images/a.webp]]\n# One\n" });
    expect((await savedCheckpoint(first.noteId))?.source).toBe("![[z-images/a.webp]]\n# One\n");
    expect(await savedCheckpoint(second.noteId)).toBeNull();
  });

  it("debounces workspace session writes while typing", async () => {
    useFakeTimers();
    const note = noteMeta("note-1", "one.md", "One");
    const client = configureVault([note], workspaceSeed([
      { noteId: note.noteId, title: note.title, path: note.path, cursorOffset: null, sourceMode: false },
    ], note.noteId));
    const { app } = mountApp();
    await app.boot();
    await flushAsync();
    await vi.advanceTimersByTimeAsync(250);
    await flushAsync();
    memory.workspaceWrites.length = 0;
    const editor = editorMock.instances[0]!;
    editor.simulateEdit("# One changed 1\n");
    editor.simulateEdit("# One changed 2\n");
    editor.simulateEdit("# One changed 3\n");
    expect(memory.workspaceWrites).toHaveLength(0);
    expect(client.saveNote).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(149);
    expect(memory.workspaceWrites).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(249);
    expect(memory.workspaceWrites).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await flushAsync();
    expect(memory.workspaceWrites).toHaveLength(1);
  });

  it("reports V2 save and delete failures in the shell", async () => {
    const note = noteMeta("note-1", "one.md", "One");
    const client = configureVault([note], workspaceSeed([
      { noteId: note.noteId, title: note.title, path: note.path, cursorOffset: null, sourceMode: false },
    ], note.noteId));
    client.saveNote.mockRejectedValueOnce(new Error("offline"));
    client.deleteNote.mockRejectedValueOnce(new Error("offline"));
    const { app, root } = mountApp();
    await app.boot();
    editorMock.instances[0]!.simulateEdit("# Changed\n");
    await runCommand(root, "save");
    await until(() => root.textContent?.includes("Save failed") === true);
    root.querySelector<HTMLButtonElement>(".tab.active")?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    root.querySelector<HTMLButtonElement>('[title="Delete note"]')?.click();
    root.querySelector<HTMLButtonElement>(".note-dialog-panel .danger-button")?.click();
    await until(() => root.textContent?.includes("Action failed") === true);
  });

  it("awaits journal flush and clears owned timers during disposal", async () => {
    useFakeTimers();
    vi.spyOn(window, "postMessage").mockImplementation(() => {});
    const note = noteMeta("note-1", "one.md", "One");
    const client = configureVault([note], workspaceSeed([
      { noteId: note.noteId, title: note.title, path: note.path, cursorOffset: null, sourceMode: false },
    ], note.noteId));
    client.saveNote.mockRejectedValueOnce(new Error("offline"));
    const services = createServices();
    const pendingFlush = deferred<boolean>();
    const journal = new DraftJournal(() => {}, 200, () => pendingFlush.promise);
    const flushAll = vi.spyOn(journal, "flushAll");
    vi.spyOn(services.workspace, "createJournal").mockReturnValue(journal);
    const root = document.createElement("div");
    document.body.append(root);
    const app = new TansuApp(root, services);
    apps.push(app);
    app.bindGlobalEvents();
    await app.boot();
    editorMock.instances[0]!.simulateEdit("# Changed\n");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "s", metaKey: true, cancelable: true }));
    await until(() => root.textContent?.includes("Save failed") === true);

    const disposing = app.dispose();
    let disposed = false;
    void disposing.then(() => {
      disposed = true;
    });
    expect(flushAll).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    await flushAsync();
    expect(disposed).toBeFalsy();
    pendingFlush.resolve(true);
    await disposing;
    expect(disposed).toBeTruthy();
  });

  it("removes the global vault menu listeners when disposed while open", async () => {
    const { app, root } = mountApp();
    await app.boot();
    const removeListener = vi.spyOn(window, "removeEventListener");
    root.querySelector<HTMLElement>(".vault-control")?.click();
    expect(root.querySelector(".vault-control")?.classList.contains("open")).toBeTruthy();
    await app.dispose();
    expect(removeListener).toHaveBeenCalledWith("pointerdown", expect.any(Function), true);
    expect(removeListener).toHaveBeenCalledWith("keydown", expect.any(Function), true);
  });

  it("shows an export action after draft checkpoint storage fails", async () => {
    useFakeTimers();
    const note = noteMeta("note-1", "one.md", "One");
    const client = configureVault([note], workspaceSeed([
      { noteId: note.noteId, title: note.title, path: note.path, cursorOffset: null, sourceMode: false },
    ], note.noteId));
    client.openNote.mockResolvedValue(documentFor(note, "# One\n"));
    const { app, root } = mountApp();
    await app.boot();
    const openingDatabase = vi.spyOn(IDBFactory.prototype, "open").mockImplementation(() => {
      throw new Error("quota exceeded");
    });
    editorMock.instances[0]!.simulateEdit("# Recover this\n");
    await vi.advanceTimersByTimeAsync(150);
    await vi.advanceTimersByTimeAsync(250);
    await flushAsync();
    expect(root.querySelector<HTMLButtonElement>('[title="Export draft"]')).not.toBeNull();
    openingDatabase.mockRestore();
    useFakeTimers();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const createUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:export");
    const revokeUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    root.querySelector<HTMLButtonElement>('[title="Export draft"]')?.click();
    expect(click).toHaveBeenCalled();
    expect(createUrl).toHaveBeenCalledWith(expect.any(Blob));
    await flushAsync();
    await vi.advanceTimersByTimeAsync(1);
    expect(revokeUrl).toHaveBeenCalledWith("blob:export");
  });

  it("keeps an unavailable saved-note checkpoint exportable until a local recreate is checkpointed", async () => {
    const lost = noteMeta("lost", "lost.md", "Lost");
    const seed = workspaceSeed([
      { noteId: lost.noteId, title: lost.title, path: lost.path, cursorOffset: null, sourceMode: false },
    ], lost.noteId);
    const client = configureVault([], seed);
    const checkpoint: DraftJournalRecord = {
      formatVersion: 1,
      serverInstanceId: "server-1",
      vaultId: DEFAULT_VAULT,
      workspaceId: workspaceId("workspace-1"),
      noteId: lost.noteId,
      baseRevision: 2,
      baseSourceHash: HASH_A,
      baseDiskHash: DISK_HASH,
      localRevision: 7,
      mutationId: "saved-mutation",
      source: "# Recover me\n",
      titleDraft: null,
      selection: { anchor: 1, head: 1 },
      checkpointedAtMs: 1,
    };
    await storeSavedCheckpoint(checkpoint);
    client.openNote.mockRejectedValue(new V2ApiError("unresolved", 404, {
      code: "unresolved_note",
      noteId: lost.noteId,
      reason: "missing_snapshot",
    }));
    const { app, root } = mountApp();
    await app.boot();
    await until(() => root.querySelector('[title="Recreate note from draft"]') !== null);
    expect(editorMock.instances[0]?.getSnapshot()?.source).toBe("# Recover me\n");
    root.querySelector<HTMLButtonElement>('[title="Recreate note from draft"]')?.click();
    await until(() => editorMock.instances[0]?.getSnapshot()?.noteId.startsWith("local:") === true);
    const localId = localIdFrom(editorMock.instances[0]!);
    await until(async () => (await localCheckpoint(localId))?.source === "# Recover me\n" &&
      await savedCheckpoint(lost.noteId) === null);
    expect((await localCheckpoint(localId))?.source).toBe("# Recover me\n");
    expect(await savedCheckpoint(lost.noteId)).toBeNull();
    await app.dispose();
  });

  it("shows a retry action after an initial note load failure", async () => {
    const note = noteMeta("note-1", "one.md", "One");
    const client = configureVault([note], workspaceSeed([
      { noteId: note.noteId, title: note.title, path: note.path, cursorOffset: null, sourceMode: false },
    ], note.noteId));
    client.openNote.mockRejectedValueOnce(new Error("connection refused"))
      .mockResolvedValueOnce(documentFor(note, "# One\n"));
    const { app, root } = mountApp();

    await app.boot();
    await until(() => root.querySelector(".unavailable-state") !== null);
    expect(root.querySelector(".unavailable-state")?.textContent).toContain("Server unavailable");
    expect(client.openNote).toHaveBeenCalledTimes(1);

    root.querySelector<HTMLButtonElement>('[title="Retry note load"]')?.click();
    await until(() => editorMock.instances.at(-1)?.getSnapshot()?.source === "# One\n");
    expect(editorMock.instances.at(-1)?.getSnapshot()?.source).toBe("# One\n");
    expect(client.openNote).toHaveBeenCalledTimes(2);
    await app.dispose();
  });

  it("locks the shell when a note retry requires authentication", async () => {
    const note = noteMeta("note-1", "one.md", "One");
    const client = configureVault([note], workspaceSeed([
      { noteId: note.noteId, title: note.title, path: note.path, cursorOffset: null, sourceMode: false },
    ], note.noteId));
    client.openNote.mockRejectedValueOnce(new Error("connection refused"))
      .mockRejectedValueOnce(new V2ApiError("Authentication required", 401, { code: "auth_required" }));
    const { app, root } = mountApp();

    await app.boot();
    await until(() => root.querySelector(".unavailable-state") !== null);
    root.querySelector<HTMLButtonElement>('[title="Retry note load"]')?.click();
    await until(() => root.querySelector(".auth-gate") !== null);

    expect(root.querySelector(".auth-gate")?.textContent).toContain("Unlock your notes");
    expect(root.querySelector(".unavailable-state")).toBeNull();
    await app.dispose();
  });

  describe("wiki links in the production editor", () => {
    const one = noteMeta("note-1", "one.md", "One");
    const two = noteMeta("note-2", "docs/two.md", "Two");

    async function mountWithLink(source: string, notes: V2NoteMeta[] = [one, two]) {
      const client = configureVault(notes, workspaceSeed([
        { noteId: one.noteId, title: one.title, path: one.path, cursorOffset: 0, sourceMode: false },
      ], one.noteId));
      client.openNote.mockImplementation(async (id) => {
        const meta = notes.find((item) => item.noteId === id)!;
        return documentFor(meta, id === one.noteId ? source : `# ${meta.title}\n`);
      });
      const mounted = mountApp({ ...createServices(), editor: { createEditor: createCodeMirrorEditor } });
      await mounted.app.boot();
      await until(() => mounted.root.querySelector(".cm-content")?.textContent?.includes("See") === true);
      return { client, ...mounted };
    }

    function wikiLink(root: HTMLElement): HTMLElement | null {
      return root.querySelector<HTMLElement>("[data-wiki-link-target]");
    }

    function click(link: HTMLElement): void {
      link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    }

    it("opens the note a rendered wiki link resolves to", async () => {
      const { client, root } = await mountWithLink("See [[Two]]\n");
      expect(wikiLink(root)).not.toBeNull();
      await until(() => wikiLink(root)!.classList.contains("cm-atomic-wiki-link-resolved"));
      const link = wikiLink(root)!;
      expect(link.textContent).toBe("Two");

      click(link);

      await until(() => root.querySelector<HTMLButtonElement>(".tab.active")?.title === "Two");
      await until(() => client.openNote.mock.calls.some(([id]) => id === two.noteId));
      await until(() => root.querySelector(".cm-content")?.textContent?.includes("See") === false);
    });

    it("keeps an ambiguous basename unresolved and does not navigate", async () => {
      const first = noteMeta("note-2", "a/Dup.md", "Dup");
      const second = noteMeta("note-3", "b/Dup.md", "Dup");
      const { client, root } = await mountWithLink("See [[Dup]]\n", [one, first, second]);
      await until(() => wikiLink(root)?.classList.contains("cm-atomic-wiki-link-unresolved") === true);

      click(wikiLink(root)!);
      await flushAsync();

      expect(client.openNote).toHaveBeenCalledTimes(1);
      expect(root.querySelector(".cm-content")?.textContent).toContain("See");
    });

    it.each([
      ["./sibling", "note-sibling"],
      ["../top", "note-top"],
      ["/docs/sibling", "note-sibling"],
    ])("resolves %s from the current note's directory", async (target, expectedId) => {
      const current = noteMeta("note-1", "docs/one.md", "One");
      const sibling = noteMeta("note-sibling", "docs/sibling.md", "Sibling");
      const top = noteMeta("note-top", "top.md", "Top");
      const client = configureVault([current, sibling, top], workspaceSeed([
        { noteId: current.noteId, title: current.title, path: current.path, cursorOffset: 0, sourceMode: false },
      ], current.noteId));
      client.openNote.mockImplementation(async (id) => {
        const meta = [current, sibling, top].find((item) => item.noteId === id)!;
        return documentFor(meta, id === current.noteId ? `See [[${target}]]\n` : `# ${meta.title}\n`);
      });
      const { app, root } = mountApp({ ...createServices(), editor: { createEditor: createCodeMirrorEditor } });
      await app.boot();
      await until(() => wikiLink(root)?.classList.contains("cm-atomic-wiki-link-resolved") === true);

      click(wikiLink(root)!);

      await until(() => client.openNote.mock.calls.some(([id]) => id === expectedId));
    });

    it("marks a missing target and does not navigate", async () => {
      const { client, root } = await mountWithLink("See [[Nowhere]]\n");
      await until(() => wikiLink(root)?.classList.contains("cm-atomic-wiki-link-missing") === true);

      click(wikiLink(root)!);
      await flushAsync();

      expect(client.openNote).toHaveBeenCalledTimes(1);
      expect(root.querySelector(".cm-content")?.textContent).toContain("See");
    });

    it("stops resolving the old name after a rename and resolves the new one", async () => {
      const { client, root } = await mountWithLink("See [[Two]] and [[Renamed]]\n");
      await until(() => root.querySelectorAll("[data-wiki-link-target]").length === 2);
      await until(() => wikiLink(root)?.classList.contains("cm-atomic-wiki-link-resolved") === true);
      const renamed = noteMeta(two.noteId, "docs/renamed.md", "Renamed", [], 2, HASH_B);

      client.eventHandlers?.onEvent({
        eventVersion: 1,
        resyncRequired: false,
        update: { kind: "vaultChanged", notes: [renamed] },
      });
      await until(() => wikiLink(root)?.classList.contains("cm-atomic-wiki-link-missing") === true);
      const [oldName, newName] = [...root.querySelectorAll<HTMLElement>("[data-wiki-link-target]")];
      expect(oldName!.classList.contains("cm-atomic-wiki-link-missing")).toBeTruthy();
      expect(newName!.classList.contains("cm-atomic-wiki-link-resolved")).toBeTruthy();

      click(oldName!);
      await flushAsync();
      expect(client.openNote).toHaveBeenCalledTimes(1);

      click(newName!);
      await until(() => client.openNote.mock.calls.some(([id]) => id === two.noteId));
    });
  });

  it("boots through the public entry point using v2 services", async () => {
    const client = configureVault([]);
    const previous = {
      api: defaultServices.api,
      workspace: defaultServices.workspace,
      editor: defaultServices.editor,
    };
    const services = createServices();
    defaultServices.api = services.api;
    defaultServices.workspace = services.workspace;
    defaultServices.editor = services.editor;
    const root = document.createElement("div");
    document.body.append(root);
    const app = startApp(root);
    apps.push(app);
    await until(() => root.textContent?.includes("No note selected") === true);
    expect(api.bootstrap).toHaveBeenCalledTimes(1);
    expect(client.bootstrap).toHaveBeenCalledTimes(1);
    defaultServices.api = previous.api;
    defaultServices.workspace = previous.workspace;
    defaultServices.editor = previous.editor;
    await app.dispose();
  });

  describe("interleavings", () => {
    function twoNoteVault() {
      const first = noteMeta("one", "one.md", "One");
      const second = noteMeta("two", "two.md", "Two");
      const client = configureVault([first, second], workspaceSeed([
        { noteId: first.noteId, title: first.title, path: first.path, cursorOffset: null, sourceMode: false },
        { noteId: second.noteId, title: second.title, path: second.path, cursorOffset: null, sourceMode: false },
      ], first.noteId));
      client.openNote.mockImplementation(async (id) => documentFor(id === first.noteId ? first : second, `# ${id}\n`));
      return { first, second, client };
    }

    it("keeps the selected tab when a delayed load resolves after switching back", async () => {
      const { first, second, client } = twoNoteVault();
      const pending = deferred<V2NoteDocument>();
      client.openNote.mockImplementation(async (id) => id === second.noteId ? pending.promise : documentFor(first, "# one\n"));
      const { app, root } = mountApp();
      await app.boot();
      const editor = editorMock.instances[0]!;

      root.querySelector<HTMLButtonElement>('[title="Two"]')?.click();
      await until(() => root.querySelector(".workspace .loading") !== null);
      root.querySelector<HTMLButtonElement>('[title="One"]')?.click();
      await until(() => editor.getSnapshot()?.noteId === "saved:one");
      pending.resolve(documentFor(second, "# Two\n"));
      await flushAsync();
      await flushAsync();

      expect(editor.getSnapshot()).toMatchObject({ noteId: "saved:one", source: "# one\n" });
      expect(root.querySelector(".tab.active")?.getAttribute("title")).toBe("One");
    });

    it("keeps the newest edit in the journal when auth expires during an in-flight save", async () => {
      const { first, client } = twoNoteVault();
      const inFlight = deferred<V2MutationResponse>();
      client.saveNote.mockReturnValue(inFlight.promise);
      const { app, root } = mountApp();
      await app.boot();
      const editor = editorMock.instances[0]!;

      editor.simulateEdit("# Sent\n");
      await flushEditorCapture();
      await runCommand(root, "save");
      await until(() => client.saveNote.mock.calls.length === 1);
      editor.simulateEdit("# Newer than the request\n");
      await flushEditorCapture();
      inFlight.reject(new V2ApiError("Authentication required", 401, { code: "auth_required" }));
      await until(() => root.querySelector(".auth-gate") !== null);

      expect(client.saveNote).toHaveBeenCalledTimes(1);
      expect((await savedCheckpoint(first.noteId))?.source).toBe("# Newer than the request\n");
    });

    it("saves the queued newer edit when a tab is closed during an in-flight save", async () => {
      useFakeTimers();
      const { first, client } = twoNoteVault();
      const inFlight = deferred<V2MutationResponse>();
      client.saveNote.mockReturnValueOnce(inFlight.promise);
      const { app, root } = mountApp();
      await app.boot();
      const editor = editorMock.instances[0]!;

      editor.simulateEdit("# Sent\n");
      await vi.advanceTimersByTimeAsync(150);
      await runCommand(root, "save");
      await flushAsync();
      expect(client.saveNote).toHaveBeenCalledTimes(1);
      editor.simulateEdit("# Queued\n");
      await vi.advanceTimersByTimeAsync(150);
      root.querySelector<HTMLButtonElement>(".tab.active .tab-close")?.click();
      await flushAsync();
      const request = client.saveNote.mock.calls[0]![1];
      inFlight.resolve(accepted(request.mutationId, noteMeta(first.noteId, first.path, first.title, [], 2, request.sourceHash)));
      await vi.advanceTimersByTimeAsync(1000);
      await flushAsync();

      expect(client.saveNote.mock.calls.map(([, sent]) => sent.content)).toStrictEqual(["# Sent\n", "# Queued\n"]);
      expect(client.saveNote.mock.calls[1]![1].precondition.baseRevision).toBe(2);
    });

    it("clears upload status and leaves the visible note alone when an upload outlives the tab switch", async () => {
      const { client } = twoNoteVault();
      const { app, root } = mountApp();
      await app.boot();
      const editor = editorMock.instances[0]!;
      const onState = editor.config["onImagePasteStateChange"] as NonNullable<EditorConfig["onImagePasteStateChange"]>;
      const paste = { uploadId: 1, noteId: "saved:one", revision: 0, selection: { anchor: 0, head: 0 } };

      onState({ ...paste, status: "uploading", previewUrl: "blob:preview" });
      expect(root.querySelector(".image-upload-status")).not.toBeNull();
      root.querySelector<HTMLButtonElement>('[title="Two"]')?.click();
      await until(() => editor.getSnapshot()?.noteId === "saved:two");
      onState({ ...paste, status: "inserted" });
      await flushAsync();

      expect(root.querySelector(".image-upload-status")).toBeNull();
      expect(editor.getSnapshot()).toMatchObject({ noteId: "saved:two", source: "# two\n" });
      expect(client.saveNote).not.toHaveBeenCalled();
    });

    it("saves an image inserted into a note after the user switched away", async () => {
      useFakeTimers();
      const { first, client } = twoNoteVault();
      const { app, root } = mountApp();
      await app.boot();
      const editor = editorMock.instances[0]!;

      root.querySelector<HTMLButtonElement>('[title="Two"]')?.click();
      await flushAsync();
      editor.simulateInactiveEdit("saved:one", "# one\n![[z-images/a.webp]]\n");
      await vi.advanceTimersByTimeAsync(150);
      await vi.advanceTimersByTimeAsync(1000);
      await flushAsync();

      expect(client.saveNote).toHaveBeenCalledWith(first.noteId, expect.objectContaining({
        content: "# one\n![[z-images/a.webp]]\n",
      }));
    });
  });
});

function createTestClient() {
  const client = {
    bootstrap: vi.fn(async (): Promise<V2VaultBootstrap> => vaultBootstrap([])),
    openNote: vi.fn(async (note: string) => documentFor(noteMeta(note, `${note}.md`, note), `# ${note}\n`)),
    createNote: vi.fn(async (request: V2CreateNoteRequest) => accepted(request.mutationId, noteMeta("created", request.path, request.path.replace(/\.md$/i, "")))),
    saveNote: vi.fn(async (note: string, request: V2SaveNoteRequest) => accepted(request.mutationId, noteMeta(note, `${note}.md`, note, [], request.precondition.baseRevision + 1, request.sourceHash))),
    renameNote: vi.fn(async (note: string, request: Parameters<V2VaultClient["renameNote"]>[1]) => accepted(request.mutationId, noteMeta(note, request.path, request.path.replace(/\.md$/i, ""), [], request.precondition.baseRevision + 1, HASH_B))),
    deleteNote: vi.fn(async (_note: string, request: Parameters<V2VaultClient["deleteNote"]>[1]) => ({ mutationId: request.mutationId, outcome: { state: "accepted", result: null } } as V2MutationResponse)),
    noteLinks: vi.fn(async () => ({ backlinks: [], outgoing: [] })),
    notePreview: vi.fn(async (id: string) => ({ noteId: id, preview: "" })),
    listRevisions: vi.fn(async () => [] as V2RevisionMeta[]),
    openRevision: vi.fn(async (note: string, revision: number): Promise<V2RevisionDocument> => ({ revision: { noteId: note, revision, kind: "save", source: "user", sourceHash: HASH_A, createdAtMs: 1 }, content: "# Old\n" })),
    openConflictDraft: vi.fn(async (note: string): Promise<V2ConflictDraftDocument> => ({ draft: conflictDraft(note), content: "# Draft\n" })),
    restoreRevision: vi.fn(async (_note: string, _revision: number, request: Parameters<V2VaultClient["restoreRevision"]>[2]) => accepted(request.mutationId, null)),
    restoreConflictDraft: vi.fn(async (_note: string, _draft: number, request: Parameters<V2VaultClient["restoreConflictDraft"]>[2]) => accepted(request.mutationId, null)),
    saveSettings: vi.fn(async (request: V2SettingsRequest) => ({ mutationId: request.mutationId, settings: request.settings })),
    search: vi.fn(async (_request: V2SearchRequest) => searchResponse([])),
    uploadImage: vi.fn(async (mutationId: string) => ({ mutationId, name: "z-images/a.webp", markdown: "![[a.webp]]" })),
    loadAsset: vi.fn(async () => new Blob(["image"], { type: "image/webp" })),
    eventHandlers: null as Parameters<V2VaultClient["connectEvents"]>[1] | null,
    connectEvents: vi.fn((_after: number, handlers: Parameters<V2VaultClient["connectEvents"]>[1]) => {
      client.eventHandlers = handlers;
      return { close: vi.fn() };
    }),
  };
  return client;
}

type TestSessionTab = { noteId: string; title: string; path: string; cursorOffset: number | null; sourceMode: boolean };
type WorkspaceSeed = Pick<WorkspaceState, "tabs" | "activeTab" | "closedTabs">;

function testClient(id = DEFAULT_VAULT): TestClient {
  let client = clients.get(id);
  if (client === undefined) {
    client = createTestClient();
    clients.set(id, client);
  }
  return client;
}

function configureVault(notes: V2NoteMeta[], seed: WorkspaceSeed | null = null, id = DEFAULT_VAULT): TestClient {
  const client = testClient(id);
  let seedWrite = workspaceSeeds;
  if (seed !== null) {
    seedWrite = workspaceSeeds.then(() => saveWorkspaceState({
      formatVersion: 1,
      serverInstanceId: "server-1",
      vaultId: id,
      workspaceId: WORKSPACE_ID,
      ...seed,
      pinnedNoteIds: [],
      recentNoteIds: [],
      searchHistory: [],
      savedAtMs: 1,
    }));
    workspaceSeeds = seedWrite;
  }
  client.bootstrap.mockImplementation(async () => {
    await seedWrite;
    return vaultBootstrap(notes, id);
  });
  client.openNote.mockImplementation(async (note) => {
    const meta = notes.find((item) => item.noteId === note) ?? noteMeta(note, `${note}.md`, note);
    return documentFor(meta, `# ${meta.title}\n`);
  });
  return client;
}

function serverIdentity(id = DEFAULT_VAULT) {
  return { serverInstanceId: serverInstanceId("server-1"), vaultId: vaultId(id) };
}

function documentIdentity(id: string, vault = DEFAULT_VAULT) {
  return { ...serverIdentity(vault), noteId: noteId(id) };
}

function storedWorkspace(vault = DEFAULT_VAULT): Promise<WorkspaceState | null> {
  return getWorkspaceState(serverIdentity(vault), WORKSPACE_ID);
}

function savedCheckpoint(id: string, vault = DEFAULT_VAULT): Promise<DraftJournalRecord | null> {
  return getDraftCheckpoint(serverIdentity(vault), WORKSPACE_ID, id);
}

function localCheckpoint(id: string, vault = DEFAULT_VAULT): Promise<LocalDraftJournalRecord | null> {
  return getLocalDraftCheckpoint(serverIdentity(vault), WORKSPACE_ID, localDraftId(id));
}

function cachedBody(note: Pick<V2NoteMeta, "noteId" | "sourceHash">, vault = DEFAULT_VAULT) {
  return getCachedNoteBody(documentIdentity(note.noteId, vault), note);
}

async function storeCachedBody(note: V2NoteMeta, content: string, vault = DEFAULT_VAULT): Promise<void> {
  await workspaceSeeds;
  await cacheNoteBody(documentIdentity(note.noteId, vault), documentFor(note, content));
}

async function storeSavedCheckpoint(record: DraftJournalRecord): Promise<boolean> {
  await workspaceSeeds;
  return writeDraftCheckpoint(record);
}

function localIdFrom(editor: FakeEditor): string {
  const session = [...editor.snapshots.keys()].find((candidate) => candidate.noteId.startsWith("local:"));
  if (session === undefined) throw new Error("Expected a local draft editor session");
  return session.noteId.slice("local:".length);
}

function vaultBootstrap(notes: V2NoteMeta[], id = DEFAULT_VAULT): V2VaultBootstrapResponse {
  return { vault: { vaultId: id, name: id }, notes, settings: settings(), searchStatus: { dirty: false, degraded: false } };
}

function workspaceSeed(openTabs: TestSessionTab[], activeNoteId: string | null, closedTabs: TestSessionTab[] = []): WorkspaceSeed {
  return {
    tabs: openTabs.map(workspaceTabFromSeed),
    activeTab: activeNoteId === null ? null : { kind: "saved", noteId: activeNoteId },
    closedTabs: closedTabs.map(workspaceTabFromSeed),
  };
}

function createServices(): AppServices {
  const workspace = {
    ...defaultServices.workspace,
    saveWorkspaceState: async (state: WorkspaceState) => {
      await defaultServices.workspace.saveWorkspaceState(state);
      memory.workspaceWrites.push(state);
    },
  };
  return {
    ...defaultServices,
    api: api as unknown as AppServices["api"],
    passkeys: { login: vi.fn(async () => {}), enroll: vi.fn(async () => {}), logout: vi.fn(async () => {}) },
    editor: { createEditor: (_container: HTMLElement, config?: EditorConfig) => createFakeEditor(config) },
    workspace,
    storage: { requestPersistent: vi.fn(async () => false) },
  };
}

function createFakeEditor(initialConfig?: EditorConfig): FakeEditor {
  const snapshots = new Map<EditorSession, EditorSnapshot>();
  let active: EditorSession | null = null;
  let config: Record<string, unknown> = { ...initialConfig };
  const editor: FakeEditor = {
    snapshots,
    get config() { return config; },
    get attachedSession() { return active; },
    createSession: vi.fn((id: string, source: string, options?: { mode?: "live" | "source"; readOnly?: boolean }) => {
      const session = { noteId: id } as EditorSession;
      snapshots.set(session, { noteId: id, source, revision: 0, selection: { anchor: 0, head: 0 }, mode: options?.mode ?? "live", readOnly: options?.readOnly ?? false, scroll: { top: 0, left: 0 }, dirty: false });
      return session;
    }),
    attachSession: vi.fn((session: EditorSession) => { active = session; }),
    detachSession: vi.fn(() => { const previous = active; active = null; return previous; }),
    dispose: vi.fn(() => { active = null; }),
    focus: vi.fn(),
    getSnapshot: vi.fn(() => active === null ? null : snapshots.get(active) ?? null),
    getSessionSnapshot: vi.fn((session: EditorSession) => {
      const snapshot = snapshots.get(session);
      if (snapshot === undefined) throw new Error("Unknown editor session");
      return snapshot;
    }),
    markSaved: vi.fn((session: EditorSession, revision: number) => {
      const snapshot = snapshots.get(session);
      if (snapshot === undefined || snapshot.revision !== revision) return false;
      snapshots.set(session, { ...snapshot, dirty: false });
      return true;
    }),
    reloadIfClean: vi.fn((session: EditorSession, source: string) => {
      const snapshot = snapshots.get(session);
      if (snapshot === undefined) throw new Error("Unknown editor session");
      if (snapshot.dirty) return { kind: "dirty" as const, revision: snapshot.revision };
      const selection = {
        anchor: Math.min(snapshot.selection.anchor, source.length),
        head: Math.min(snapshot.selection.head, source.length),
      };
      snapshots.set(session, { ...snapshot, source, selection, revision: snapshot.revision + 1 });
      return { kind: "reloaded" as const, revision: snapshot.revision + 1 };
    }),
    setMode: vi.fn((mode: "live" | "source") => { if (active !== null) snapshots.set(active, { ...snapshots.get(active)!, mode }); }),
    updateConfiguration: vi.fn((partial: Partial<EditorConfig>) => { config = { ...config, ...partial }; }),
    revealSelection: vi.fn((selection: EditorSnapshot["selection"]) => { if (active !== null) snapshots.set(active, { ...snapshots.get(active)!, selection }); return true; }),
    revealOutlineHeading: vi.fn(() => true),
    scrollByWheel: vi.fn(() => false),
    find: vi.fn(() => []),
    setFindHighlights: vi.fn(),
    revealFindMatch: vi.fn(() => true),
    outline: vi.fn(() => ({
      complete: true,
      headings: (active === null ? "" : snapshots.get(active)!.source).split("\n").flatMap((text, line) =>
        text.startsWith("# ") ? [{ level: 1, line, text: text.slice(2), from: 0, to: text.length }] : []
      ),
    })),
    formatSelection: vi.fn(),
    undo: vi.fn(() => true),
    redo: vi.fn(() => true),
    simulateInactiveEdit(noteKey: string, source: string) {
      const entry = [...snapshots.entries()].find(([session, snapshot]) => snapshot.noteId === noteKey && session !== active);
      if (entry === undefined) throw new Error(`No inactive editor session for ${noteKey}`);
      const [session, snapshot] = entry;
      snapshots.set(session, { ...snapshot, source, revision: snapshot.revision + 1, dirty: true });
      (config["onChange"] as ((change: { noteId: string; revision: number; origin: "userEdit" }) => void) | undefined)?.({ noteId: noteKey, revision: snapshot.revision + 1, origin: "userEdit" });
    },
    simulateEdit(source: string, selection = { anchor: source.length, head: source.length }) {
      if (active === null) throw new Error("No editor session is active");
      const snapshot = snapshots.get(active)!;
      const updated = { ...snapshot, source, revision: snapshot.revision + 1, selection, dirty: true };
      snapshots.set(active, updated);
      (config["onChange"] as ((change: { noteId: string; revision: number; origin: "userEdit" }) => void) | undefined)?.({ noteId: updated.noteId, revision: updated.revision, origin: "userEdit" });
    },
    simulateEditIn(noteId: string, source: string) {
      const session = [...snapshots.keys()].find((candidate) => candidate.noteId === noteId);
      if (session === undefined) throw new Error(`No editor session for ${noteId}`);
      const snapshot = snapshots.get(session)!;
      const updated = { ...snapshot, source, revision: snapshot.revision + 1, dirty: true };
      snapshots.set(session, updated);
      (config["onChange"] as ((change: { noteId: string; revision: number; origin: "userEdit" }) => void) | undefined)?.({ noteId, revision: updated.revision, origin: "userEdit" });
    },
  };
  editorMock.instances.push(editor);
  return editor;
}

type FakeEditor = EditorHandle & { readonly config: Record<string, unknown>; readonly snapshots: Map<EditorSession, EditorSnapshot>; readonly attachedSession: EditorSession | null; simulateEdit: (source: string, selection?: EditorSnapshot["selection"]) => void; simulateInactiveEdit: (noteKey: string, source: string) => void; simulateEditIn: (noteId: string, source: string) => void };

function importRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    channel: "tansu",
    version: 1,
    type: "import.request",
    requestId: "request-1",
    title: "Imported",
    markdown: "# Imported\n",
    sourceUrl: "https://example.com/page",
    images: [],
    ...overrides,
  };
}

function sendImport(overrides: Record<string, unknown> = {}, source: unknown = window, origin = window.location.origin): void {
  window.dispatchEvent(new MessageEvent("message", { data: importRequest(overrides), origin, source: source as MessageEventSource }));
}

function postedMessages(post: { mock: { calls: unknown[][] } }, type: string): Array<Record<string, unknown>> {
  return post.mock.calls.map((call) => call[0] as Record<string, unknown>).filter((message) => message["type"] === type);
}

function mountApp(services: AppServices = createServices()): { app: TansuApp; root: HTMLElement } {
  const root = document.createElement("div");
  document.body.append(root);
  const app = new TansuApp(root, services);
  app.bindGlobalEvents();
  apps.push(app);
  return { app, root };
}

function noteMeta(id: string, path: string, title: string, tags: string[] = [], revision = 1, sourceHash = HASH_A): V2NoteMeta {
  return { noteId: id, path, title, tags, revision, sourceHash, diskHash: DISK_HASH, sourceHashFormatVersion: 3, diskHashFormatVersion: 2, updatedAtMs: revision };
}

function documentFor(meta: V2NoteMeta, content: string): V2NoteDocument { return { meta, content }; }
function accepted(mutationId: string, meta: V2NoteMeta | null): V2MutationResponse { return { mutationId, outcome: { state: "accepted", result: meta } }; }
function conflictDraft(id: string) { return { draftId: 9, noteId: id, baseRevision: 1, baseSourceHash: HASH_A, sourceHash: HASH_B, createdAtMs: 1 }; }
function searchHit(meta: V2NoteMeta) { return { identity: { kind: "canonical" as const, noteId: meta.noteId, revision: meta.revision, sourceHash: meta.sourceHash }, title: meta.title, path: meta.path, score: 1, excerpt: meta.title, excerptRanges: [{ startUtf16: 0, endUtf16: meta.title.length }], sourceRange: null }; }
function searchResponse(hits: V2SearchResponse["hits"], overlayCoverage: V2SearchResponse["overlayCoverage"] = { status: "complete" }): V2SearchResponse { return { hits, overlayCoverage }; }
function settings(): Settings { return { excludedFolders: [], searchTitleWeight: 3, searchHeadingWeight: 2, searchTagWeight: 2, searchContentWeight: 1, recencyBoost: 0, autosaveDelayMs: 900, undoStackMax: 100, imageWebpQuality: 0.8 }; }
function workspaceTabFromSeed(tab: TestSessionTab): WorkspaceTab { return { kind: "saved", noteId: tab.noteId, title: tab.title, path: tab.path, selection: tab.cursorOffset === null ? null : { anchor: tab.cursorOffset, head: tab.cursorOffset }, scrollTop: 0, mode: tab.sourceMode ? "source" : "live" }; }
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; }
async function flushAsync(): Promise<void> {
  for (let task = 0; task < 4; task += 1) {
    for (let index = 0; index < 12; index += 1) await Promise.resolve();
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
async function flushEditorCapture(): Promise<void> {
  if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(150);
  else await new Promise<void>((resolve) => window.setTimeout(resolve, 160));
  await flushAsync();
}
function useFakeTimers(): void { vi.useFakeTimers({ toNotFake: ["setImmediate", "clearImmediate"] }); }
async function until(predicate: () => boolean | Promise<boolean>): Promise<void> { for (let index = 0; index < 80; index += 1) { if (await predicate()) return; await flushAsync(); } throw new Error(`Expected asynchronous work did not finish: ${document.body.textContent}`); }
async function openSearch(root: HTMLElement): Promise<void> {
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "/", ctrlKey: true, cancelable: true }));
  await until(() => root.querySelector(".search-panel") !== null);
}
async function openRecentNote(root: HTMLElement, title?: string): Promise<void> {
  await openSearch(root);
  const row = [...root.querySelectorAll<HTMLButtonElement>(".recent-search-result")].find((candidate) =>
    title === undefined || candidate.querySelector(".search-result-title")?.textContent === title
  );
  if (row === undefined) throw new Error(`Recent note was not rendered: ${title ?? "first note"}`);
  row.click();
  await flushAsync();
}
async function runCommand(root: HTMLElement, query: string): Promise<void> {
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, cancelable: true }));
  await until(() => root.querySelector(".command-panel") !== null);
  const input = root.querySelector<HTMLInputElement>(".command-input");
  if (input === null) throw new Error("Command palette did not open");
  input.value = query;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  const command = [...root.querySelectorAll<HTMLButtonElement>(".command-row")].find((row) =>
    row.title.toLowerCase().includes(query.toLowerCase())
  );
  command?.click();
  await flushAsync();
}

function useShellFixtures(): void {
  beforeEach(() => {
    clients.clear();
    workspaceSeeds = Promise.resolve();
    vi.stubGlobal("indexedDB", new IDBFactory());
    vi.stubGlobal("IDBKeyRange", IDBKeyRange);
    localStorage.clear();
    localStorage.setItem("tansu.workspace.v1", "workspace-1");
    memory.workspaceWrites.length = 0;
    editorMock.instances.length = 0;
    api.bootstrap.mockReset().mockResolvedValue({
      apiVersion: 2,
      serverInstanceId: "server-1",
      vaults: [{ vaultId: DEFAULT_VAULT, name: "Notes" }, { vaultId: "vault-2", name: "Other notes" }],
    });
    api.forVault.mockClear();
    let sequence = 0;
    vi.stubGlobal("crypto", {
      randomUUID: vi.fn(() => `mutation-${++sequence}`),
      subtle: { digest: vi.fn(async () => new Uint8Array(32).buffer) },
    });
    document.body.replaceChildren();
  });
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.dispose()));
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });
}

describe("wiki link failure notices", () => {
  useShellFixtures();
  const one = noteMeta("note-1", "one.md", "One");

  async function mountWithLink(source: string, notes: V2NoteMeta[]) {
    const client = configureVault(notes, workspaceSeed([
      { noteId: one.noteId, title: one.title, path: one.path, cursorOffset: 0, sourceMode: false },
    ], one.noteId));
    client.openNote.mockImplementation(async (id) => {
      const meta = notes.find((item) => item.noteId === id)!;
      return documentFor(meta, id === one.noteId ? source : `# ${meta.title}\n`);
    });
    const mounted = mountApp({ ...createServices(), editor: { createEditor: createCodeMirrorEditor } });
    await mounted.app.boot();
    await until(() => mounted.root.querySelector("[data-wiki-link-target]") !== null);
    return { client, ...mounted };
  }

  function clickLink(root: HTMLElement): void {
    root.querySelector<HTMLElement>("[data-wiki-link-target]")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
  }

  it("tells the user when a link target is ambiguous", async () => {
    const { root } = await mountWithLink("See [[Dup]]\n", [one, noteMeta("note-2", "a/Dup.md", "Dup"), noteMeta("note-3", "b/Dup.md", "Dup")]);
    clickLink(root);
    await until(() => root.textContent?.includes('Link "Dup" matches more than one note') === true);
  });

  it("tells the user when a link target does not exist", async () => {
    const { root } = await mountWithLink("See [[Nowhere]]\n", [one]);
    clickLink(root);
    await until(() => root.textContent?.includes('No note found for link "Nowhere"') === true);
  });

  it("does not show a notice for a link that resolves", async () => {
    const two = noteMeta("note-2", "two.md", "Two");
    const { root } = await mountWithLink("See [[Two]]\n", [one, two]);
    await until(() => root.querySelector("[data-wiki-link-target]")?.classList.contains("cm-atomic-wiki-link-resolved") === true);
    clickLink(root);
    await until(() => root.querySelector<HTMLButtonElement>(".tab.active")?.title === "Two");
    expect(root.textContent).not.toContain("No note found");
    expect(root.textContent).not.toContain("more than one note");
  });
});

describe("extension import", () => {
  useShellFixtures();
  const note = noteMeta("note-1", "one.md", "One");
  const imported = noteMeta("imported", "imported.md", "Imported");
  const webpImage = (id: number, base64: string | null) => ({ id, url: `https://example.com/${id}.webp`, contentType: "image/webp", base64 });

  function importVault() {
    const client = configureVault([note]);
    client.createNote.mockImplementation(async (request) => accepted(request.mutationId, imported));
    client.openNote.mockImplementation(async (id) => id === imported.noteId
      ? documentFor(imported, "# Imported\n")
      : documentFor(note, "# One\n"));
    return client;
  }

  it("announces readiness after boot and answers pings", async () => {
    importVault();
    const post = vi.spyOn(window, "postMessage");
    const { app } = mountApp();
    await app.boot();
    expect(postedMessages(post, "import.ready")).toHaveLength(1);
    expect(post.mock.calls[0]?.[1]).toBe(window.location.origin);

    window.dispatchEvent(new MessageEvent("message", {
      data: { channel: "tansu", type: "import.ping" },
      origin: window.location.origin,
      source: window,
    }));
    expect(postedMessages(post, "import.ready")).toHaveLength(2);
  });

  it("uploads images before creating the note, rewrites embeds, and posts the result", async () => {
    const client = importVault();
    const order: string[] = [];
    client.uploadImage.mockImplementation(async (id: string) => {
      order.push("upload");
      return { mutationId: id, name: "z-images/a.webp", markdown: "![[a.webp]]" };
    });
    client.createNote.mockImplementation(async (request) => {
      order.push("create");
      return accepted(request.mutationId, imported);
    });
    const { app, root } = mountApp();
    await app.boot();
    const post = vi.spyOn(window, "postMessage");

    sendImport({
      markdown: "# Imported\n\n![a [b]](tansu-import-image:0)\n![c](tansu-import-image:1)\n",
      images: [webpImage(0, btoa("RIFFxxxxWEBP")), webpImage(1, null)],
    });
    await until(() => postedMessages(post, "import.result").length === 1);

    expect(order).toStrictEqual(["upload", "create"]);
    expect(client.createNote.mock.calls[0]?.[0]).toMatchObject({
      path: "imported.md",
      content: "# Imported\n\n![[a.webp]]\n![c](https://example.com/1.webp)\n",
    });
    expect(postedMessages(post, "import.result")[0]).toStrictEqual({
      channel: "tansu",
      version: 1,
      type: "import.result",
      requestId: "request-1",
      ok: true,
      noteId: imported.noteId,
      path: imported.path,
      imagesLocalized: 1,
      imagesFailed: 1,
    });
    await until(() => root.querySelector<HTMLButtonElement>(".tab.active")?.title === "Imported");
  });

  it("keeps the remote image when an upload fails", async () => {
    const client = importVault();
    client.uploadImage.mockRejectedValue(new Error("offline"));
    const { app } = mountApp();
    await app.boot();
    const post = vi.spyOn(window, "postMessage");

    sendImport({ markdown: "![x](tansu-import-image:0)", images: [webpImage(0, btoa("RIFFxxxxWEBP"))] });
    await until(() => postedMessages(post, "import.result").length === 1);

    expect(client.createNote.mock.calls[0]?.[0]).toMatchObject({ content: "![x](https://example.com/0.webp)" });
    expect(postedMessages(post, "import.result")[0]).toMatchObject({ ok: true, imagesLocalized: 0, imagesFailed: 1 });
  });

  it("rejects invalid payloads without side effects", async () => {
    const client = importVault();
    const { app } = mountApp();
    await app.boot();
    const post = vi.spyOn(window, "postMessage");

    sendImport({ markdown: 5 });
    await until(() => postedMessages(post, "import.result").length === 1);

    expect(postedMessages(post, "import.result")[0]).toMatchObject({ ok: false, requestId: "request-1" });
    expect(client.createNote).not.toHaveBeenCalled();
    expect(client.uploadImage).not.toHaveBeenCalled();
  });

  it("ignores messages from other sources or origins", async () => {
    const client = importVault();
    const { app } = mountApp();
    await app.boot();
    const post = vi.spyOn(window, "postMessage");

    sendImport({}, document.createElement("iframe").contentWindow);
    sendImport({}, window, "https://evil.example");
    await flushAsync();

    expect(postedMessages(post, "import.result")).toHaveLength(0);
    expect(client.createNote).not.toHaveBeenCalled();
  });

  it("ignores requests while the app is not ready", async () => {
    importVault();
    const { app } = mountApp();
    const post = vi.spyOn(window, "postMessage");
    sendImport();
    await flushAsync();
    expect(post).not.toHaveBeenCalled();
    await app.boot();
  });
});

describe("asset url cache", () => {
  useShellFixtures();
  const noteA = noteMeta("note-a", "a.md", "A");
  const noteB = noteMeta("note-b", "b.md", "B");

  async function mountTwoTabs(contentA: string, contentB: string) {
    const client = configureVault([noteA, noteB], workspaceSeed([
      { noteId: noteA.noteId, title: noteA.title, path: noteA.path, cursorOffset: null, sourceMode: false },
      { noteId: noteB.noteId, title: noteB.title, path: noteB.path, cursorOffset: null, sourceMode: false },
    ], noteA.noteId));
    client.openNote.mockImplementation(async (id) =>
      id === noteA.noteId ? documentFor(noteA, contentA) : documentFor(noteB, contentB));
    const created: string[] = [];
    const revoked: string[] = [];
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => {
      const url = `blob:image-${created.length}`;
      created.push(url);
      return url;
    });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation((url) => { revoked.push(url); });
    const mounted = mountApp();
    await mounted.app.boot();
    const resolveUrl = (name: string): string | null => {
      const editor = editorMock.instances[0]!;
      const configs: Partial<EditorConfig>[] = [
        editor.config as Partial<EditorConfig>,
        ...vi.mocked(editor.updateConfiguration).mock.calls.map((call) => call[0]),
      ];
      const resolveAssetUrl = configs.toReversed().find((item) => item.resolveAssetUrl !== undefined)?.resolveAssetUrl;
      if (resolveAssetUrl === undefined) throw new Error("Editor asset resolver was not configured");
      return resolveAssetUrl(name);
    };
    const switchTo = async (title: string) => {
      mounted.root.querySelector<HTMLButtonElement>(`.tab[title="${title}"]`)!.click();
      await flushAsync();
    };
    return { client, created, revoked, resolveUrl, switchTo, ...mounted };
  }

  it("keeps the same object URL for an image across tab switches", async () => {
    const { client, created, revoked, resolveUrl, switchTo } = await mountTwoTabs("![[z-images/a.webp]]\n", "![[z-images/b.webp]]\n");
    await until(() => resolveUrl("z-images/a.webp") !== null);
    const first = resolveUrl("z-images/a.webp");

    await switchTo("B");
    await until(() => resolveUrl("z-images/b.webp") !== null);
    await switchTo("A");
    await flushAsync();

    expect(resolveUrl("z-images/a.webp")).toBe(first);
    expect(client.loadAsset.mock.calls.filter((call) => (call as unknown[])[0] === "z-images/a.webp")).toHaveLength(1);
    expect(created).toHaveLength(2);
    expect(revoked).toHaveLength(0);
  });

  it("evicts past 64 entries without leaving a revoked url resolvable", async () => {
    const many = `${Array.from({ length: 70 }, (_, index) => `![[z-images/p${index}.webp]]`).join("\n")}\n`;
    const { created, revoked, resolveUrl, switchTo } = await mountTwoTabs("![[z-images/a.webp]]\n", many);
    await until(() => resolveUrl("z-images/a.webp") !== null);

    await switchTo("B");
    await until(() => created.length === 71);
    await flushAsync();
    await switchTo("A");
    await until(() => resolveUrl("z-images/a.webp") !== null);
    await flushAsync();

    const live = resolveUrl("z-images/a.webp");
    expect(revoked).not.toContain(live);
    for (let index = 0; index < 70; index += 1) {
      const url = resolveUrl(`z-images/p${index}.webp`);
      if (url !== null) expect(revoked).not.toContain(url);
    }
    expect(revoked.length).toBeGreaterThan(0);
  });
});

describe("saved tab load completions", () => {
  useShellFixtures();
  const first = noteMeta("first", "first.md", "First");
  const second = noteMeta("second", "second.md", "Second");

  it("drops a network body that arrives after the vault switched", async () => {
    const oldClient = configureVault([first], workspaceSeed([
      { noteId: first.noteId, title: first.title, path: first.path, cursorOffset: null, sourceMode: false },
    ], first.noteId));
    const pending = deferred<V2NoteDocument>();
    oldClient.openNote.mockReturnValue(pending.promise);
    configureVault([second], workspaceSeed([
      { noteId: second.noteId, title: second.title, path: second.path, cursorOffset: null, sourceMode: false },
    ], second.noteId), "vault-2");
    const { app, root } = mountApp();
    const oldBoot = app.boot();
    await until(() => oldClient.openNote.mock.calls.length === 1);
    await app.boot("vault-2");

    pending.resolve(documentFor(first, "# Old vault body\n"));
    await oldBoot;
    await flushAsync();

    expect(await cachedBody(first)).toBeNull();
    expect(root.textContent).not.toContain("Old vault body");
    expect(root.querySelector('.tab[title="First"]')).toBeNull();
  });

  it("neither caches nor resurrects a note whose tab closed while it loaded", async () => {
    const other = noteMeta("other", "other.md", "Other");
    const client = configureVault([first, other], workspaceSeed([
      { noteId: first.noteId, title: first.title, path: first.path, cursorOffset: null, sourceMode: false },
      { noteId: other.noteId, title: other.title, path: other.path, cursorOffset: null, sourceMode: false },
    ], first.noteId));
    const pending = deferred<V2NoteDocument>();
    client.openNote.mockImplementation((id) => id === first.noteId ? pending.promise : Promise.resolve(documentFor(other, "# Other\n")));
    const { app, root } = mountApp();
    const booting = app.boot();
    await until(() => client.openNote.mock.calls.some(([id]) => id === first.noteId));
    root.querySelector<HTMLButtonElement>('.tab[title="First"] .tab-close')!.click();
    await flushAsync();

    pending.resolve(documentFor(first, "# Late\n"));
    await booting;
    await flushAsync();

    expect(await cachedBody(first)).toBeNull();
    expect(root.querySelector('.tab[title="First"]')).toBeNull();
  });

  it("does not report a load failure for a tab that closed while it loaded", async () => {
    const other = noteMeta("other", "other.md", "Other");
    const client = configureVault([first, other], workspaceSeed([
      { noteId: first.noteId, title: first.title, path: first.path, cursorOffset: null, sourceMode: false },
      { noteId: other.noteId, title: other.title, path: other.path, cursorOffset: null, sourceMode: false },
    ], first.noteId));
    const pending = deferred<V2NoteDocument>();
    client.openNote.mockImplementation((id) => id === first.noteId ? pending.promise : Promise.resolve(documentFor(other, "# Other\n")));
    const { app, root } = mountApp();
    const booting = app.boot();
    await until(() => client.openNote.mock.calls.some(([id]) => id === first.noteId));
    root.querySelector<HTMLButtonElement>('.tab[title="First"] .tab-close')!.click();
    await flushAsync();

    pending.reject(new Error("offline"));
    await booting;
    await flushAsync();

    expect(root.querySelector('.tab[title="First"]')).toBeNull();
    expect(root.querySelector(".unavailable-state")).toBeNull();
  });
});

describe("document controller outlives its tab", () => {
  useShellFixtures();

  it("loads a reopened note only after the closing save settles", async () => {
    useFakeTimers();
    const note = noteMeta("note-1", "one.md", "One");
    const saved = noteMeta(note.noteId, note.path, note.title, [], 2, HASH_B);
    const client = configureVault([note], workspaceSeed([
      { noteId: note.noteId, title: note.title, path: note.path, cursorOffset: null, sourceMode: false },
    ], note.noteId));
    client.openNote.mockResolvedValue(documentFor(note, "# One\n"));
    const save = deferred<V2MutationResponse>();
    client.saveNote.mockReturnValue(save.promise);
    const { app, root } = mountApp();
    await app.boot();
    editorMock.instances[0]!.simulateEdit("# Closed early\n");
    await vi.advanceTimersByTimeAsync(150);
    await flushAsync();

    root.querySelector<HTMLButtonElement>(".tab.active .tab-close")?.click();
    await flushAsync();
    expect(client.saveNote).toHaveBeenCalledTimes(1);
    await openRecentNote(root, "One");
    await flushAsync();
    expect(client.openNote).toHaveBeenCalledTimes(1);

    client.openNote.mockResolvedValue(documentFor(saved, "# Closed early\n"));
    save.resolve(accepted(client.saveNote.mock.calls[0]![1].mutationId, saved));
    await until(() => client.openNote.mock.calls.length === 2);
    await until(() => editorMock.instances[0]?.getSnapshot()?.source === "# Closed early\n");
  });

  it("loads a reopened note only after an in-flight revision restore settles", async () => {
    const note = noteMeta("note-1", "one.md", "One");
    const restored = noteMeta(note.noteId, note.path, note.title, [], 2, HASH_B);
    const revision = { noteId: note.noteId, revision: 4, kind: "save" as const, source: "user" as const, sourceHash: HASH_B, createdAtMs: 5 };
    const client = configureVault([note], workspaceSeed([
      { noteId: note.noteId, title: note.title, path: note.path, cursorOffset: null, sourceMode: false },
    ], note.noteId));
    client.openNote.mockResolvedValue(documentFor(note, "# One\n"));
    client.listRevisions.mockResolvedValue([revision]);
    client.openRevision.mockResolvedValue({ revision, content: "# Restored\n" });
    const restore = deferred<V2MutationResponse>();
    client.restoreRevision.mockReturnValue(restore.promise);
    const { app, root } = mountApp();
    await app.boot();
    await runCommand(root, "revisions");
    root.querySelector<HTMLButtonElement>(".revision-row")?.click();
    await flushAsync();
    root.querySelector<HTMLButtonElement>(".revisions-panel .primary-button")?.click();
    await until(() => client.restoreRevision.mock.calls.length === 1);
    root.querySelector<HTMLButtonElement>(".tab-close")?.click();
    await flushAsync();
    await openRecentNote(root, "One");
    await flushAsync();
    expect(client.openNote).toHaveBeenCalledTimes(1);

    client.openNote.mockResolvedValue(documentFor(restored, "# Restored\n"));
    restore.resolve(accepted(client.restoreRevision.mock.calls[0]![2].mutationId, restored));
    await until(() => editorMock.instances[0]?.getSnapshot()?.source === "# Restored\n");
  });
});
