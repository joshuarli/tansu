import { commandItems } from "./app/commands.ts";
import type { CommandId, EditorToolbarCommand, ViewEvent } from "./app/events.ts";
import { DocumentSession, defaultDocumentSessionServices, type DocumentSessionState } from "./app/document-session.ts";
import { LocalDraftSession } from "./app/local-draft-session.ts";
import { defaultServices, type AppServices } from "./app/services.ts";
import { localDraftId, noteId, serverInstanceId, vaultId, type DocumentIdentity, type LocalDraftId, type ServerIdentity, type WorkspaceId } from "./app/identity.ts";
import { sameTabIdentity, toTabKey, type TabIdentity } from "./app/tab-identity.ts";
import { logClientEvent } from "./dev-log.ts";
import { V2ApiError } from "./app/v2-api.ts";
import type { EditorHandle, EditorSession } from "./editor/codemirror-adapter.ts";
import { createCalloutExtension, createWikiImageExtension, type EditorConfig } from "./editor/tansu-extensions.ts";
import { normalizeTag } from "./markdown-tags.ts";
import { canonicalSourceHash } from "./save-delta.ts";
import {
  activeTab,
  createState,
  loadedDraft,
  normalizeMarkdownNewlines,
  tabById,
  tabFromDocument,
  tabFromMeta,
  tabFromWorkspace,
  tabIdentity,
  tabIsDirty,
  toNoteId,
  workspaceTabFromTab,
  type SavedTab,
  type State,
  type Tab,
} from "./state.ts";
import { disposeAppView, renderApp, renderAuthGate, renderLoading, renderNoVaultConfigured, updateAppView, updateStatusBar, type ViewActions } from "./view.ts";
import type { Settings, V2BootstrapResponse, V2MutationResponse, V2NoteDocument, V2NoteMeta, V2QuickOpenResponse, V2SearchHit, V2SearchOverlay, V2ServerEvent } from "./types.generated.ts";
import type { DraftJournalRecord, WorkspaceState } from "./app/workspace-store.ts";

const SESSION_SAVE_DELAY_MS = 250;
const EDITOR_CAPTURE_DELAY_MS = 150;
const MIN_SEARCH_QUERY_CHARS = 3;

export class TansuApp {
  private readonly state: State;
  private readonly workspaceId: WorkspaceId;
  private identity: ServerIdentity | null = null;
  private journal: ReturnType<AppServices["workspace"]["createJournal"]> | null = null;
  private detachVisibilityFlush: (() => void) | null = null;
  private vaultClient: ReturnType<AppServices["api"]["forVault"]> | null = null;
  private editor: EditorHandle | null = null;
  private cachedEditorConfig: {
    generation: number;
    identity: ServerIdentity | null;
    client: ReturnType<AppServices["api"]["forVault"]> | null;
    assetScopeRevision: number;
    config: EditorConfig;
  } | null = null;
  private activeEditorKey: string | null = null;
  private attachedEditor: { tab: Tab; session: EditorSession } | null = null;
  private readonly editorMount = document.createElement("div");
  private readonly noteLoads = new Map<string, Promise<void>>();
  private readonly autoSaveTimers = new Map<string, number>();
  private editorCaptureTimer: number | undefined;
  private readonly inFlightActions = new Set<Promise<unknown>>();
  private readonly assetScope = new Map<string, string>();
  private assetScopeRevision = 0;
  private readonly globalEventCleanups: Array<() => void> = [];
  private assetController: AbortController | null = null;
  private eventSubscription: { close: () => void } | null = null;
  private workspaceTimer: number | undefined;
  private noticeTimer: number | undefined;
  private disposeTask: Promise<void> | null = null;
  private searchRequestSeq = 0;
  private searchOverlayRequestSeq = 0;
  private quickOpenRequestSeq = 0;
  private bootGeneration = 0;
  private sessionGeneration = 0;
  private transitioningVault = false;
  private noVaultConfigured = false;
  private disposed = false;
  private overlayReturn: {
    element: HTMLElement | null;
    tab: Tab | undefined;
    editorFocused: boolean;
    selection: { anchor: number; head: number } | null;
  } | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly services: AppServices = defaultServices,
  ) {
    this.state = createState(vaultId("boot"));
    this.workspaceId = this.services.workspace.createWorkspaceId();
    this.editorMount.className = "editor-mount";
    this.editorMount.id = "editor-mount";
  }

  async boot(requestedVault?: string): Promise<void> {
    const generation = ++this.bootGeneration;
    this.transitioningVault = true;
    this.state.imageUploads.clear();
    this.searchRequestSeq += 1;
    this.searchOverlayRequestSeq += 1;
    this.quickOpenRequestSeq += 1;
    this.eventSubscription?.close();
    this.eventSubscription = null;
    this.cancelAutoSaves();
    if (this.workspaceTimer !== undefined) window.clearTimeout(this.workspaceTimer);
    this.workspaceTimer = undefined;
    this.configureActiveEditor(true);
    this.captureActiveEditor();
    let global: V2BootstrapResponse;
    try {
      global = await this.services.api.bootstrap();
    } catch (error) {
      if (error instanceof V2ApiError && error.kind?.code === "auth_required") {
        await this.lockForAuthentication();
        return;
      }
      this.restoreCurrentVault(generation);
      throw error;
    }
    if (generation !== this.bootGeneration || this.disposed) return;
    const selected = global.vaults.find((vault) => vault.vaultId === requestedVault) ??
      global.vaults.find((vault) => vault.vaultId === this.state.vault) ?? global.vaults[0];
    if (selected === undefined) {
      if (this.identity === null) {
        this.state.boot = null;
        this.noVaultConfigured = true;
        this.transitioningVault = false;
        this.render();
      }
      else {
        this.restoreCurrentVault(generation);
        this.notify("No vault is configured");
      }
      return;
    }
    this.noVaultConfigured = false;
    const nextIdentity: ServerIdentity = {
      serverInstanceId: serverInstanceId(global.serverInstanceId),
      vaultId: vaultId(selected.vaultId),
    };
    const nextClient = this.services.api.forVault(global.serverInstanceId, selected.vaultId);
    let vaultBootstrap: Awaited<ReturnType<typeof nextClient.bootstrap>>;
    let imported: WorkspaceState;
    try {
      vaultBootstrap = await nextClient.bootstrap();
      if (generation !== this.bootGeneration || this.disposed) return;
      imported = await this.services.workspace.importLegacyWorkspaceOnce(
        nextIdentity,
        this.workspaceId,
        vaultBootstrap.legacyWorkspace,
      );
    } catch (error) {
      this.restoreCurrentVault(generation);
      throw error;
    }
    if (generation !== this.bootGeneration || this.disposed) return;
    await this.drainInFlightActions();
    if (generation !== this.bootGeneration || this.disposed) return;
    if (this.identity !== null) {
      try {
        await this.flushOutgoingWorkspace(this.identity);
      } catch (error) {
        this.restoreCurrentVault(generation);
        this.notifyStorageFailure(error);
        return;
      }
      if (generation !== this.bootGeneration || this.disposed) return;
      if (this.identity.serverInstanceId === nextIdentity.serverInstanceId &&
        this.identity.vaultId === nextIdentity.vaultId) {
        imported = this.workspaceSnapshot(this.identity);
      }
    }
    this.cancelAssetScope();
    for (const tab of this.state.tabs) if (tab.kind === "saved") tab.session?.close();
    for (const timer of this.autoSaveTimers.values()) window.clearTimeout(timer);
    this.autoSaveTimers.clear();
    this.noteLoads.clear();
    this.state.vault = nextIdentity.vaultId;
    this.state.serverInstanceId = global.serverInstanceId;
    this.identity = nextIdentity;
    this.vaultClient = nextClient;
    this.state.boot = { ...vaultBootstrap, serverInstanceId: global.serverInstanceId, vaults: global.vaults };
    this.state.authRequired = false;
    this.state.notes = new Map(vaultBootstrap.notes.map((meta) => [meta.noteId, meta]));
    this.state.pinned = new Set(imported.pinnedNoteIds.filter((id) => this.state.notes.has(id)));
    this.state.recent = imported.recentNoteIds.filter((id) => this.state.notes.has(id));
    this.state.tabs = imported.tabs.map(tabFromWorkspace);
    this.state.closedTabs = imported.closedTabs;
    this.state.activeTab = imported.activeTab !== null && this.state.tabs.some((tab) =>
        sameTabIdentity(tabIdentity(tab), identityOfWorkspaceIdentity(imported.activeTab!))
      )
      ? identityOfWorkspaceIdentity(imported.activeTab)
      : this.state.tabs[0] === undefined ? null : tabIdentity(this.state.tabs[0]);
    this.transitioningVault = false;
    this.scheduleWorkspaceSave();
    this.connectEvents(generation);
    this.render();
    const active = activeTab(this.state);
    if (active !== undefined) await this.ensureTabLoaded(active);
  }

  private async flushOutgoingWorkspace(identity: ServerIdentity): Promise<void> {
    for (;;) {
      this.captureActiveEditor();
      if (this.workspaceTimer !== undefined) window.clearTimeout(this.workspaceTimer);
      this.workspaceTimer = undefined;
      await Promise.all([
        this.services.workspace.saveWorkspaceState(this.workspaceSnapshot(identity)),
        this.journal?.flushAll() ?? Promise.resolve(),
      ]);
      if (this.workspaceTimer === undefined) return;
    }
  }

  private async drainInFlightActions(): Promise<void> {
    while (this.inFlightActions.size > 0) {
      await Promise.allSettled(this.inFlightActions);
    }
  }

  private trackAction<T>(action: Promise<T>): Promise<T> {
    const tracked = action.finally(() => this.inFlightActions.delete(tracked));
    this.inFlightActions.add(tracked);
    return tracked;
  }

  private cancelAutoSaves(): void {
    for (const timer of this.autoSaveTimers.values()) window.clearTimeout(timer);
    this.autoSaveTimers.clear();
  }

  private restoreCurrentVault(generation: number): void {
    if (generation !== this.bootGeneration || this.disposed) return;
    this.transitioningVault = false;
    if (this.identity !== null) this.connectEvents(generation);
    this.render();
    for (const tab of this.state.tabs) {
      if (tab.kind === "saved" && tabIsDirty(tab)) this.scheduleAutoSave(tab);
    }
    const active = activeTab(this.state);
    const source = active === undefined ? null : loadedDraft(active);
    if (active !== undefined && source !== null) void this.prefetchAssets(active, source);
  }

  bindGlobalEvents(): void {
    if (this.globalEventCleanups.length > 0) return;
    const onBeforeUnload = () => {
      this.captureActiveEditor();
      this.persistWorkspace();
      void this.journal?.flushAll();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (this.transitioningVault || this.state.authRequired || this.state.boot === null) return;
      const modifier = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      if (modifier && key === "k" && !event.altKey && !event.shiftKey) {
        event.preventDefault();
        this.dispatch({ type: "command.open" });
      } else if (modifier && key === "p" && !event.altKey && !event.shiftKey) {
        event.preventDefault();
        this.dispatch({ type: "quickOpen.open" });
      } else if (modifier && event.shiftKey && key === "f" && !event.altKey) {
        event.preventDefault();
        this.dispatch({ type: "search.open" });
      } else if (modifier && !event.shiftKey && !event.altKey && key === "f") {
        event.preventDefault();
        this.dispatch({ type: "find.open" });
      } else if (modifier && key === "s" && !event.altKey && !event.shiftKey) {
        event.preventDefault();
        this.runAsync(this.manualSave(), "Save failed");
      } else if (modifier && event.altKey && !event.shiftKey && key === "n") {
        event.preventDefault();
        this.runAsync(this.commandCreate(), "Create failed");
      } else if (event.key === "Escape" && this.hasOverlay()) {
        event.preventDefault();
        this.runAsync(this.closeOverlays(), "Local recovery storage failed");
      }
    };
    const onClick = (event: MouseEvent) => {
      if (this.state.contextMenu !== null && event.target instanceof HTMLElement &&
        event.target.closest(".context-menu") === null) {
        this.state.contextMenu = null;
        this.render();
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("click", onClick);
    this.globalEventCleanups.push(
      () => window.removeEventListener("beforeunload", onBeforeUnload),
      () => window.removeEventListener("keydown", onKeyDown),
      () => window.removeEventListener("click", onClick),
    );
  }

  dispose(): Promise<void> {
    if (this.disposeTask !== null) return this.disposeTask;
    this.disposed = true;
    this.transitioningVault = false;
    ++this.bootGeneration;
    for (const cleanup of this.globalEventCleanups.splice(0)) cleanup();
    this.captureActiveEditor();
    let pendingJournalFlush: Promise<void>;
    try {
      pendingJournalFlush = this.journal?.flushAll() ?? Promise.resolve();
    } catch (error) {
      pendingJournalFlush = Promise.reject(error);
    }
    this.eventSubscription?.close();
    this.eventSubscription = null;
    this.cancelAssetScope();
    this.detachVisibilityFlush?.();
    this.detachVisibilityFlush = null;
    for (const tab of this.state.tabs) if (tab.kind === "saved") tab.session?.close();
    this.editor?.dispose();
    this.editor = null;
    this.activeEditorKey = null;
    this.attachedEditor = null;
    for (const timer of this.autoSaveTimers.values()) window.clearTimeout(timer);
    this.autoSaveTimers.clear();
    if (this.workspaceTimer !== undefined) window.clearTimeout(this.workspaceTimer);
    this.workspaceTimer = undefined;
    if (this.noticeTimer !== undefined) window.clearTimeout(this.noticeTimer);
    this.noticeTimer = undefined;
    disposeAppView(this.root);
    this.root.replaceChildren();
    this.disposeTask = pendingJournalFlush;
    return this.disposeTask;
  }

  private connectEvents(generation: number): void {
    this.eventSubscription?.close();
    if (this.vaultClient === null) return;
    const client = this.vaultClient;
    const identity = this.identity;
    if (identity === null) return;
    this.eventSubscription = this.vaultClient.connectEvents(0, {
      onEvent: (event) => {
        if (generation !== this.bootGeneration || this.transitioningVault || !this.isCurrentVault(identity, client)) return;
        const task = this.trackAction(this.applyServerEvent(event));
        void task.catch((error) => logClientEvent("warn", "client.events", { error: errorSummary(error) }));
      },
      onResync: async (snapshot) => {
        if (generation !== this.bootGeneration || this.transitioningVault || !this.isCurrentVault(identity, client)) return;
        await this.trackAction((async () => {
          if (generation !== this.bootGeneration || this.transitioningVault || !this.isCurrentVault(identity, client)) return;
          this.state.boot = {
            ...snapshot.bootstrap,
            serverInstanceId: this.state.serverInstanceId!,
            vaults: this.state.boot?.vaults ?? [],
          };
          this.state.notes = new Map(snapshot.notes.map((meta) => [meta.noteId, meta]));
          for (const tab of this.state.tabs) {
            if (tab.kind === "saved") await this.reconcileTab(tab);
          }
          if (generation === this.bootGeneration && this.isCurrentVault(identity, client)) this.render();
        })());
      },
      onError: (error) => logClientEvent("warn", "client.events", { error: errorSummary(error) }),
    });
  }

  private async applyServerEvent(event: V2ServerEvent): Promise<void> {
    if (event.update.kind === "noteChanged") {
      this.state.notes.set(event.update.note.noteId, event.update.note);
      const tab = tabById(this.state, event.update.note.noteId);
      if (tab !== undefined) await this.reconcileTab(tab);
    } else if (event.update.kind === "vaultChanged") {
      for (const meta of event.update.notes) {
        this.state.notes.set(meta.noteId, meta);
        const tab = tabById(this.state, meta.noteId);
        if (tab !== undefined) await this.reconcileTab(tab);
      }
    } else if (event.update.kind === "noteDeleted") {
      this.state.notes.delete(event.update.noteId);
      await this.services.workspace.deleteCachedNoteBodies({ ...this.identity!, noteId: noteId(event.update.noteId) });
      await this.closeTab({ kind: "saved", noteId: toNoteId(event.update.noteId) }, false);
    } else if (event.update.kind === "searchChanged" && this.state.boot !== null) {
      this.state.boot.searchStatus = { dirty: event.update.dirty, degraded: event.update.degraded };
    }
    this.render();
  }

  private async reconcileTab(tab: SavedTab): Promise<void> {
    if (tab.session === null || this.vaultClient === null) return;
    const client = this.vaultClient;
    const serverIdentity = this.identity;
    if (serverIdentity === null) return;
    const note = this.state.notes.get(tab.noteId);
    if (note === undefined) return;
    if (tab.doc?.meta.revision === note.revision && tab.doc.meta.sourceHash === note.sourceHash &&
      tab.doc.meta.diskHash === note.diskHash) return;
    const document = await client.openNote(tab.noteId);
    if (!this.isCurrentTab(tab, serverIdentity, client)) return;
    const before = tab.session.state;
    const result = tab.session.reconcile(document);
    tab.doc = document;
    const sessionState = tab.session.state;
    if ("titleDraft" in sessionState && sessionState.titleDraft !== null) tab.title = sessionState.titleDraft;
    tab.path = document.meta.path;
    if (result === "reloaded" && this.activeEditorKey === tab.key && tab.editorSession !== null) {
      this.editor?.reloadIfClean(tab.editorSession, document.content);
    }
    if (before.status === "saving" && before.phase === "pendingMaterialization") {
      await tab.session.resolvePendingMaterialization(document.meta);
    }
    this.cacheDocument(document);
  }

  private render(): void {
    if (this.disposed) return;
    this.captureActiveEditor();
    this.root.dataset["sidebarCollapsed"] = String(this.state.sidebarCollapsed);
    const view = this.state.authRequired
      ? [renderAuthGate(this.state, this.viewActions())]
      : this.noVaultConfigured ? [renderNoVaultConfigured()]
      : this.state.boot === null ? [renderLoading()] : renderApp(this.state, this.viewActions());
    if (this.state.authRequired) {
      this.editor?.detachSession();
      this.activeEditorKey = null;
      this.attachedEditor = null;
      this.editorMount.hidden = true;
      this.editorMount.inert = true;
    }
    const placeholder = view.flatMap((node) => [...node.querySelectorAll<HTMLElement>("#editor-mount")])[0] ??
      view.find((node) => node.id === "editor-mount");
    if (placeholder !== undefined && placeholder !== null && this.state.boot !== null && !this.editorMount.isConnected) {
      placeholder.replaceWith(this.editorMount);
    }
    updateAppView(this.root, view);
    if (this.state.boot !== null && !this.state.authRequired) {
      this.ensureEditor();
      this.attachActiveEditor();
      this.scheduleWorkspaceSave();
    }
  }

  private renderStatusOnly(): void {
    const status = this.root.querySelector(".statusbar");
    if (status instanceof HTMLElement) updateStatusBar(status, this.state);
  }

  private ensureEditor(): void {
    const tab = activeTab(this.state);
    if (this.editor !== null || !this.editorMount.isConnected || tab === undefined || loadedDraft(tab) === null) return;
    this.editor = this.services.editor.createEditor(this.editorMount, this.editorConfig());
  }

  private editorConfig(): EditorConfig {
    const generation = this.bootGeneration;
    const serverIdentity = this.identity;
    const client = this.vaultClient;
    const cached = this.cachedEditorConfig;
    const sameVault = cached !== null && cached.generation === generation && cached.identity === serverIdentity && cached.client === client;
    if (sameVault && cached !== null && cached.assetScopeRevision === this.assetScopeRevision) {
      return cached.config;
    }
    const extensions = [
      createWikiImageExtension({ resolveUrl: (name) => this.resolveAssetUrl(name) }),
      createCalloutExtension(),
    ];
    if (sameVault && cached !== null) {
      const config = { ...cached.config, extensions };
      this.cachedEditorConfig = { generation, identity: serverIdentity, client, assetScopeRevision: this.assetScopeRevision, config };
      return config;
    }
    const currentVault = () => serverIdentity !== null && client !== null && this.isCurrentVault(serverIdentity, client);
    const config: EditorConfig = {
      extensions,
      currentNotePath: () => activeTab(this.state)?.path ?? "",
      wikiNotes: () => [...this.state.notes.values()].map((note) => ({ noteId: note.noteId, title: note.title, path: note.path })),
      onWikiNoteOpen: (id) => {
        if (generation === this.bootGeneration && !this.transitioningVault && currentVault()) {
          this.runAsync(this.openNote(toNoteId(id)), "Open failed");
        }
      },
      onLinkOpen: (url) => window.open(url, "_blank", "noopener,noreferrer"),
      uploadPastedImage: async ({ image, signal }) => {
        if (generation !== this.bootGeneration || this.transitioningVault || !currentVault()) {
          throw new DOMException("Image upload was canceled because the vault changed", "AbortError");
        }
        const response = await client!.uploadImage(mutationId(), image, signal);
        return { name: response.name, markdown: response.markdown };
      },
      onImagePasteStateChange: (paste) => {
        if (generation !== this.bootGeneration || this.transitioningVault || !currentVault()) return;
        if (paste.status === "uploading") {
          this.state.imageUploads.add(paste.uploadId);
          this.render();
          return;
        }
        this.state.imageUploads.delete(paste.uploadId);
        if (paste.status === "failed") {
          this.notify(`Image upload failed: ${paste.message}`);
        } else if (paste.status === "stale") {
          this.notify("Image was not inserted because its note changed.");
        } else {
          this.render();
        }
      },
      onSave: () => {
        if (generation === this.bootGeneration && !this.transitioningVault && currentVault()) {
          this.runAsync(this.manualSave(), "Save failed");
        }
      },
      onChange: () => {
        if (generation !== this.bootGeneration || this.transitioningVault || !currentVault()) return;
        const tab = activeTab(this.state);
        if (tab === undefined || this.attachedEditor?.tab !== tab) return;
        tab.dirty = true;
        if (this.editorCaptureTimer !== undefined) window.clearTimeout(this.editorCaptureTimer);
        this.editorCaptureTimer = window.setTimeout(() => {
          this.editorCaptureTimer = undefined;
          if (generation !== this.bootGeneration || this.transitioningVault ||
            !currentVault() || !this.state.tabs.includes(tab) || this.attachedEditor?.tab !== tab) return;
          this.captureActiveEditor();
          this.renderStatusOnly();
          this.scheduleWorkspaceSave();
        }, EDITOR_CAPTURE_DELAY_MS);
        this.renderStatusOnly();
      },
      onFindRequested: () => {
        if (generation !== this.bootGeneration || this.transitioningVault || !currentVault()) return;
        this.dispatch({ type: "find.open" });
      },
    };
    this.cachedEditorConfig = { generation, identity: serverIdentity, client, assetScopeRevision: this.assetScopeRevision, config };
    return config;
  }

  private attachActiveEditor(): void {
    const tab = activeTab(this.state);
    if (tab === undefined || loadedDraft(tab) === null) {
      if (this.editor !== null && this.attachedEditor !== null) this.editor.detachSession();
      this.activeEditorKey = null;
      this.attachedEditor = null;
      this.setEditorMountVisible(false);
      return;
    }
    if (this.editor === null) return;
    const currentKey = tab.key;
    const attached = this.attachedEditor;
    if (attached?.tab !== tab || attached.session !== tab.editorSession) {
      this.captureActiveEditor();
      this.editor.detachSession();
      this.activeEditorKey = currentKey;
      if (tab.editorSession === null) {
        const source = loadedDraft(tab) ?? "";
        tab.editorSession = this.editor.createSession(tab.key, source, {
          mode: tab.sourceMode ? "source" : "live",
          readOnly: this.state.readingMode || (tab.kind === "local-draft" && tab.session?.state.promotionPending === true),
        });
      }
      this.editor.attachSession(tab.editorSession);
      this.attachedEditor = { tab, session: tab.editorSession };
      if (tab.selection !== null) this.editor.revealSelection(tab.selection);
      this.editor.updateConfiguration({ ...this.editorConfig(), mode: tab.sourceMode ? "source" : "live", readOnly: this.transitioningVault || this.state.readingMode || (tab.kind === "local-draft" && tab.session?.state.promotionPending === true) });
      void this.prefetchAssets(tab, loadedDraft(tab) ?? "");
      this.services.performance.markNextPaint("tansu:editor:first-editable-paint");
    } else {
      this.editor.updateConfiguration({ ...this.editorConfig(), mode: tab.sourceMode ? "source" : "live", readOnly: this.transitioningVault || this.state.readingMode || (tab.kind === "local-draft" && tab.session?.state.promotionPending === true) });
    }
    this.setEditorMountVisible(true);
  }

  private setEditorMountVisible(visible: boolean): void {
    this.editorMount.hidden = !visible;
    this.editorMount.inert = !visible;
    if (visible) this.editorMount.removeAttribute("aria-hidden");
    else this.editorMount.setAttribute("aria-hidden", "true");
  }

  private configureActiveEditor(readOnly: boolean): void {
    const tab = activeTab(this.state);
    if (tab === undefined || this.editor === null) return;
    this.editor.updateConfiguration({
      ...this.editorConfig(),
      mode: tab.sourceMode ? "source" : "live",
      readOnly: readOnly || this.state.readingMode || (tab.kind === "local-draft" && tab.session?.state.promotionPending === true),
    });
  }

  private captureActiveEditor(): void {
    if (this.editorCaptureTimer !== undefined) {
      window.clearTimeout(this.editorCaptureTimer);
      this.editorCaptureTimer = undefined;
    }
    const tab = this.activeEditorKey === null
      ? undefined
      : this.state.tabs.find((candidate) => candidate.key === this.activeEditorKey);
    const snapshot = this.editor?.getSnapshot();
    const attached = this.attachedEditor;
    if (tab === undefined || attached === null || attached.tab !== tab || attached.session !== tab.editorSession ||
      snapshot === null || snapshot === undefined || snapshot.noteId !== tab.key) return;
    tab.selection = snapshot.selection;
    tab.scrollTop = snapshot.scroll.top;
    tab.sourceMode = snapshot.mode === "source";
    tab.editorRevision = snapshot.revision;
    const source = normalizeMarkdownNewlines(snapshot.source);
    if (tab.kind === "saved") {
      const before = tab.session?.state;
      if (before !== undefined && "draft" in before && before.draft !== null) {
        if (before.draft.source !== source) {
          tab.session?.edit(source, snapshot.selection);
          if (tab.session !== null && tabIsDirty(tab)) this.scheduleAutoSave(tab);
        } else if (!sameSelection(before.draft.selection, snapshot.selection)) tab.session?.updateSelection(snapshot.selection);
      }
    } else if (!tab.session?.state.promotionPending) {
      tab.session?.edit(source, snapshot.selection);
    }
  }

  private async ensureTabLoaded(tab: Tab): Promise<void> {
    if (tab.kind === "local-draft") {
      if (tab.session === null) await this.loadLocalDraft(tab);
      return;
    }
    if (tab.session !== null && tab.doc !== null) return;
    const key = `${this.state.serverInstanceId}:${this.state.vault}:${tab.noteId}`;
    const existing = this.noteLoads.get(key);
    if (existing !== undefined) return existing;
    const load = this.loadSavedTab(tab);
    this.noteLoads.set(key, load);
    try {
      await load;
    } finally {
      if (this.noteLoads.get(key) === load) this.noteLoads.delete(key);
    }
  }

  private async loadSavedTab(tab: SavedTab): Promise<void> {
    if (this.identity === null || this.vaultClient === null) return;
    const serverIdentity = this.identity;
    const client = this.vaultClient;
    const identity: DocumentIdentity = { ...serverIdentity, noteId: tab.noteId };
    const generation = ++this.sessionGeneration;
    const journal = this.ensureJournal();
    const clear = this.services.workspace.checkpointClearer(journal, this.workspaceId);
    const services = defaultDocumentSessionServices(
      async (documentIdentity, responseGeneration, request) => ({
        identity: { serverInstanceId: documentIdentity.serverInstanceId, vaultId: documentIdentity.vaultId, noteId: documentIdentity.noteId },
        generation: responseGeneration,
        response: await client.saveNote(documentIdentity.noteId, request),
      }),
      this.services.workspace.checkpointWriter(journal),
      clear,
    );
    services.clearTitleCheckpoint = this.services.workspace.titleCheckpointClearer(journal, this.workspaceId);
    const session = new DocumentSession(identity, generation, this.workspaceId, services);
    tab.session = session;
    session.subscribe((value) => this.onDocumentSessionState(tab, session, serverIdentity, client, value));
    const [checkpoint, cached] = await Promise.all([
      this.services.workspace.getDraftCheckpoint(identity, this.workspaceId, tab.noteId),
      this.services.workspace.getCachedNoteBody(identity, this.state.notes.get(tab.noteId) ?? { noteId: tab.noteId, sourceHash: "" }),
    ]);
    const cachedDocument: V2NoteDocument | null = cached !== null && this.state.notes.has(tab.noteId)
      ? { meta: this.state.notes.get(tab.noteId)!, content: cached.content }
      : null;
    if (this.disposed || tab.session !== session || !this.state.tabs.includes(tab) ||
      this.identity.serverInstanceId !== serverIdentity.serverInstanceId ||
      this.identity.vaultId !== serverIdentity.vaultId || this.vaultClient !== client) return;
    if (cachedDocument !== null && tab.doc === null) {
      tab.doc = cachedDocument;
      tab.draft = cachedDocument.content;
      tab.selection = selectionWithin(tab.selection, cachedDocument.content.length);
      if (checkpoint !== null) session.recover(cachedDocument, checkpoint);
      else session.loaded(cachedDocument, tab.selection);
      this.render();
    }
    try {
      const document = await client.openNote(tab.noteId);
      if (this.disposed || tab.session !== session || !this.state.tabs.includes(tab) ||
        this.identity?.serverInstanceId !== serverIdentity.serverInstanceId ||
        this.identity.vaultId !== serverIdentity.vaultId || this.vaultClient !== client) return;
      const cached = tab.doc;
      tab.doc = document;
      tab.selection = selectionWithin(tab.selection, document.content.length);
      if (session.state.status === "loading") {
        if (checkpoint !== null) session.recover(document, checkpoint);
        else session.loaded(document, tab.selection);
      } else if (cached !== null) {
        session.reconcile(document);
      }
      this.cacheDocument(document);
      const editor = tab.editorSession;
      if (editor !== null) this.editor?.reloadIfClean(editor, loadedDraft(tab) ?? document.content);
    } catch (error) {
      if (this.disposed || tab.session !== session || !this.state.tabs.includes(tab) ||
        this.identity?.serverInstanceId !== serverIdentity.serverInstanceId ||
        this.identity.vaultId !== serverIdentity.vaultId || this.vaultClient !== client) return;
      if (error instanceof V2ApiError && error.kind?.code === "auth_required") {
        await this.lockForAuthentication();
        return;
      }
      if (cachedDocument !== null) {
        if (checkpoint !== null) session.recover(cachedDocument, checkpoint);
        else session.loaded(cachedDocument, tab.selection);
        session.markUnavailable(error);
      } else if (checkpoint !== null) {
        session.recoverUnavailable(checkpoint, error, tab.title, tab.path);
      } else {
        session.markUnavailable(error);
      }
    }
    this.render();
  }

  private async loadLocalDraft(tab: Extract<Tab, { kind: "local-draft" }>): Promise<void> {
    const identity = this.identity;
    const client = this.vaultClient;
    if (identity === null || client === null) return;
    const journal = this.ensureJournal();
    const session = new LocalDraftSession(identity, this.workspaceId, tab.localDraftId, {
      createMutationId: mutationId,
      checkpoint: this.services.workspace.localCheckpointWriter(journal),
    });
    const checkpoint = await this.services.workspace.getLocalDraftCheckpoint(identity, this.workspaceId, tab.localDraftId);
    if (!this.isCurrentVault(identity, client) || !this.state.tabs.includes(tab)) return;
    if (checkpoint !== null) {
      session.recover(checkpoint);
    } else {
      session.editTitle(tab.title);
      session.edit(tab.draft ?? "", tab.selection, "structural");
    }
    tab.session = session;
    session.subscribe((value) => {
      if (tab.session !== session || !this.state.tabs.includes(tab) || !this.isCurrentVault(identity, client)) return;
      tab.title = value.titleDraft;
      tab.draft = value.source;
      tab.selection = value.selection;
      tab.dirty = true;
      tab.saving = value.promotionPending;
      this.render();
      this.scheduleWorkspaceSave();
    });
    this.render();
  }

  private onDocumentSessionState(
    tab: SavedTab,
    session: DocumentSession,
    identity: ServerIdentity,
    client: ReturnType<AppServices["api"]["forVault"]>,
    value: DocumentSessionState,
  ): void {
    if (tab.session !== session || !this.isCurrentTab(tab, identity, client)) return;
    const wasSaving = tab.saving;
    tab.draft = "draft" in value && value.draft !== null ? value.draft.source : null;
    if ("draft" in value && value.draft !== null) tab.selection = value.draft.selection;
    tab.dirty = value.status === "dirty" || value.status === "saving" || value.status === "conflict" ||
      value.status === "unavailable" && value.draft !== null ||
      value.status === "auth-locked" && value.draft.mutationId !== null;
    tab.saving = value.status === "saving";
    tab.savePending = value.status === "saving" && value.phase === "pendingMaterialization";
    tab.conflict = value.status === "conflict";
    tab.conflictDraftId = value.status === "conflict" && value.conflictDraft !== null ? value.conflictDraft.draftId as SavedTab["conflictDraftId"] : null;
    if ("title" in value) tab.title = value.titleDraft ?? value.title;
    if ("path" in value) tab.path = value.path;
    if (value.status === "auth-locked") {
      this.runAsync(this.lockForAuthentication(), "Local recovery storage failed", false);
      return;
    }
    this.render();
    this.scheduleWorkspaceSave();
    if (value.status === "clean" && tab.doc !== null) {
      tab.doc = {
        meta: {
          ...tab.doc.meta,
          title: value.title,
          path: value.path,
          revision: value.base.revision,
          sourceHash: value.base.sourceHash,
          diskHash: value.base.diskHash,
        },
        content: value.draft.source,
      };
      this.state.notes.set(tab.noteId, tab.doc.meta);
      if (tab.editorSession !== null) this.editor?.markSaved(tab.editorSession, tab.editorRevision);
      this.cacheDocument(tab.doc);
    }
    if (wasSaving && value.status === "unavailable") this.notify("Save failed");
  }

  private async activateTab(identity: TabIdentity): Promise<void> {
    const outgoingTab = this.attachedEditor?.tab;
    this.captureActiveEditor();
    if (outgoingTab?.kind === "saved" && tabIsDirty(outgoingTab)) this.scheduleAutoSave(outgoingTab);
    this.state.activeTab = identity;
    if (identity.kind === "saved") this.touchRecent(identity.noteId);
    this.cancelAssetScope();
    this.render();
    const tab = activeTab(this.state);
    if (tab !== undefined) await this.ensureTabLoaded(tab);
  }

  private async openNote(id: ReturnType<typeof toNoteId>): Promise<void> {
    let tab = tabById(this.state, id);
    const meta = this.state.notes.get(id);
    if (tab === undefined && meta !== undefined) {
      tab = tabFromMeta(meta);
      this.state.tabs.push(tab);
    }
    if (tab !== undefined) await this.activateTab({ kind: "saved", noteId: tab.noteId });
  }

  private async retryNote(id: ReturnType<typeof toNoteId>): Promise<void> {
    const tab = tabById(this.state, id);
    const session = tab?.kind === "saved" ? tab.session : null;
    if (tab?.kind !== "saved" || session === null || session.state.status !== "unavailable" ||
      session.state.reason.kind === "unresolved" ||
      this.identity === null || this.vaultClient === null) return;
    if (session.state.draft === null) {
      session.close();
      tab.session = null;
      await this.loadSavedTab(tab);
      return;
    }
    const identity = this.identity;
    const client = this.vaultClient;
    try {
      const document = await client.openNote(id);
      if (!this.isCurrentTab(tab, identity, client) || tab.session !== session) return;
      tab.doc = document;
      tab.selection = selectionWithin(tab.selection, document.content.length);
      const result = session.reconcile(document);
      if (result === "reloaded" && tab.editorSession !== null) {
        this.editor?.reloadIfClean(tab.editorSession, document.content);
      }
      this.render();
    } catch (error) {
      if (!this.isCurrentTab(tab, identity, client) || tab.session !== session) return;
      if (error instanceof V2ApiError && error.kind?.code === "auth_required") {
        await this.lockForAuthentication();
        return;
      }
      session.markUnavailable(error);
      throw error;
    }
  }

  private async openLocalDraft(id: LocalDraftId): Promise<void> {
    let tab = this.state.tabs.find((candidate) => candidate.kind === "local-draft" && candidate.localDraftId === id);
    if (tab === undefined && this.identity !== null) {
      tab = this.localDraftTab(id, "", "");
      this.state.tabs.push(tab);
    }
    if (tab !== undefined) await this.activateTab({ kind: "local-draft", localDraftId: id });
  }

  private async closeTab(identity: TabIdentity, remember = true): Promise<void> {
    this.captureActiveEditor();
    const index = this.state.tabs.findIndex((tab) => sameTabIdentity(tabIdentity(tab), identity));
    if (index === -1) return;
    const candidate = this.state.tabs[index];
    if (candidate === undefined) return;
    const sessionState = candidate.session?.state;
    const titleDraftPending = sessionState !== undefined && "titleDraft" in sessionState && sessionState.titleDraft !== null;
    const checkpointPending = candidate.kind === "local-draft" || tabIsDirty(candidate) || titleDraftPending;
    const wasActive = sameTabIdentity(this.state.activeTab, identity);
    if (checkpointPending) {
      if (wasActive) this.configureActiveEditor(true);
      try {
        await this.journal?.flushAll();
      } catch (error) {
        if (wasActive) this.configureActiveEditor(false);
        this.notifyStorageFailure(error);
        return;
      }
      if (!this.state.tabs.includes(candidate)) return;
    }
    const [closed] = this.state.tabs.splice(this.state.tabs.indexOf(candidate), 1);
    if (closed === undefined) return;
    if (closed.kind === "saved") {
      this.noteLoads.delete(`${this.state.serverInstanceId}:${this.state.vault}:${closed.noteId}`);
    }
    if (closed.session !== null) {
      if (closed.kind === "saved") closed.session.close();
    }
    const autoSave = this.autoSaveTimers.get(closed.key);
    if (autoSave !== undefined) {
      window.clearTimeout(autoSave);
      this.autoSaveTimers.delete(closed.key);
    }
    if (remember) this.state.closedTabs = [workspaceTabFromTab(closed), ...this.state.closedTabs.filter((item) => !sameTabIdentity(identityOfWorkspace(item), identity))].slice(0, 50);
    if (sameTabIdentity(this.state.activeTab, identity)) {
      this.state.activeTab = this.state.tabs[Math.max(0, index - 1)] === undefined
        ? this.state.tabs[0] === undefined ? null : tabIdentity(this.state.tabs[0])
        : tabIdentity(this.state.tabs[Math.max(0, index - 1)]!);
      this.cancelAssetScope();
    }
    if (closed.kind === "saved" && this.identity !== null && this.vaultClient !== null) {
      const identity = this.identity;
      const client = this.vaultClient;
      const deletion = this.services.workspace.deleteCachedNoteBodies({ ...identity, noteId: closed.noteId }).catch((error) => {
        if (this.isCurrentVault(identity, client)) logClientEvent("warn", "client.storage", { error: errorSummary(error) });
      });
      this.trackAction(deletion);
    }
    this.render();
    this.persistWorkspace();
  }

  private async manualSave(): Promise<void> {
    this.captureActiveEditor();
    const tab = activeTab(this.state);
    if (tab?.kind === "saved" && tab.session !== null) await tab.session.save();
    else if (tab?.kind === "local-draft") {
      this.state.noteDialog = { kind: "create", localDraftId: tab.localDraftId, title: tab.title };
      this.render();
    }
  }

  private scheduleAutoSave(tab: SavedTab): void {
    const old = this.autoSaveTimers.get(tab.key);
    if (old !== undefined) window.clearTimeout(old);
    const delay = this.state.boot?.settings.autosaveDelayMs ?? 900;
    const session = tab.session;
    if (session === null) return;
    const timer = window.setTimeout(() => {
      this.autoSaveTimers.delete(tab.key);
      if (tab.session === session && tabIsDirty(tab)) this.runAsync(session.save(), "Save failed");
    }, delay);
    this.autoSaveTimers.set(tab.key, timer);
  }

  private workspaceSnapshot(identity: ServerIdentity): WorkspaceState {
    return {
      formatVersion: 1,
      serverInstanceId: identity.serverInstanceId,
      vaultId: identity.vaultId,
      workspaceId: this.workspaceId,
      tabs: this.state.tabs.map(workspaceTabFromTab),
      activeTab: this.state.activeTab,
      closedTabs: this.state.closedTabs,
      pinnedNoteIds: [...this.state.pinned],
      recentNoteIds: this.state.recent,
      searchHistory: [],
      legacySessionImported: true,
      savedAtMs: Date.now(),
    };
  }

  private async saveWorkspaceState(snapshot: WorkspaceState): Promise<void> {
    await this.trackAction(this.services.workspace.saveWorkspaceState(snapshot).catch((error) => {
      this.notifyStorageFailure(error);
      throw error;
    }));
  }

  private persistWorkspace(): void {
    this.captureActiveEditor();
    if (this.workspaceTimer !== undefined) window.clearTimeout(this.workspaceTimer);
    this.workspaceTimer = undefined;
    if (this.identity !== null) {
      void this.saveWorkspaceState(this.workspaceSnapshot(this.identity)).catch(() => undefined);
    }
  }

  private scheduleWorkspaceSave(): void {
    if (this.identity === null) return;
    const snapshot = this.workspaceSnapshot(this.identity);
    if (this.workspaceTimer !== undefined) window.clearTimeout(this.workspaceTimer);
    this.workspaceTimer = window.setTimeout(() => {
      this.workspaceTimer = undefined;
      void this.saveWorkspaceState(snapshot).catch(() => undefined);
    }, SESSION_SAVE_DELAY_MS);
  }

  private async updateSearch(): Promise<void> {
    const request = ++this.searchRequestSeq;
    const query = this.state.searchQuery.trim();
    const client = this.vaultClient;
    const serverIdentity = this.identity;
    if (query.length < MIN_SEARCH_QUERY_CHARS || client === null || serverIdentity === null) {
      this.state.searchHits = null;
      this.state.searchCoverage = null;
      this.render();
      return;
    }
    const response = await client.search({ query, mode: "default", limit: 50, overlays: this.searchOverlays() });
    if (request !== this.searchRequestSeq || this.state.searchQuery.trim() !== query ||
      !this.isCurrentVault(serverIdentity, client)) return;
    this.state.searchHits = response.hits;
    this.state.searchCoverage = response.overlayCoverage;
    this.render();
  }

  private async updateSearchOverlay(): Promise<void> {
    const request = ++this.searchOverlayRequestSeq;
    const query = this.state.searchOverlayQuery.trim();
    const client = this.vaultClient;
    const serverIdentity = this.identity;
    if (query.length < MIN_SEARCH_QUERY_CHARS || client === null || serverIdentity === null) {
      this.state.searchOverlayHits = null;
      this.state.searchOverlayCoverage = null;
      this.render();
      return;
    }
    const response = await client.search({ query, mode: "default", limit: 50, overlays: this.searchOverlays() });
    if (request !== this.searchOverlayRequestSeq || this.state.searchOverlayQuery.trim() !== query ||
      !this.isCurrentVault(serverIdentity, client)) return;
    this.state.searchOverlayHits = response.hits;
    this.state.searchOverlayCoverage = response.overlayCoverage;
    this.render();
  }

  private async updateQuickOpen(): Promise<void> {
    const request = ++this.quickOpenRequestSeq;
    const query = this.state.quickOpenQuery.trim();
    const client = this.vaultClient;
    const serverIdentity = this.identity;
    if (client === null || serverIdentity === null) {
      this.state.quickOpenHits = null;
      this.render();
      return;
    }
    const response = await client.quickOpen({
      query,
      pinnedNoteIds: [...this.state.pinned],
      recentNoteIds: this.state.recent,
      limit: 50,
    });
    if (request !== this.quickOpenRequestSeq || this.state.quickOpenQuery.trim() !== query ||
      !this.isCurrentVault(serverIdentity, client)) return;
    this.state.quickOpenHits = response.hits;
    this.render();
  }

  private async openQuickOpenHit(hit: V2QuickOpenResponse["hits"][number]): Promise<void> {
    const client = this.vaultClient;
    const serverIdentity = this.identity;
    if (client === null || serverIdentity === null) return;
    const document = await client.openNote(hit.noteId);
    if (!this.isCurrentVault(serverIdentity, client)) return;
    if (document.meta.sourceHash !== hit.sourceHash) {
      await this.updateQuickOpen();
      return;
    }
    this.state.notes.set(document.meta.noteId, document.meta);
    await this.openNote(toNoteId(hit.noteId));
    const active = activeTab(this.state);
    const source = active === undefined ? null : loadedDraft(active);
    if (source === null || await canonicalSourceHash(source) !== hit.sourceHash) {
      await this.updateQuickOpen();
      return;
    }
    this.state.quickOpen = false;
    this.overlayReturn = null;
    this.editor?.focus();
    this.render();
  }

  private refreshSearchResults(): Promise<void> {
    return this.state.searchOpen ? this.updateSearchOverlay() : this.updateSearch();
  }

  private async openSearchHit(hit: V2SearchHit): Promise<void> {
    const identity = hit.identity;
    if (identity.kind === "newLocalDraft") {
      const tab = this.state.tabs.find((candidate) => candidate.kind === "local-draft" && candidate.localDraftId === identity.localId);
      const source = tab === undefined ? null : loadedDraft(tab);
      if (tab === undefined || source === null || await canonicalSourceHash(source) !== identity.sourceHash) {
        await this.refreshSearchResults();
        return;
      }
      await this.openLocalDraft(localDraftId(identity.localId));
    } else if (identity.kind === "savedOverlay") {
      const tab = tabById(this.state, identity.noteId);
      const source = tab === undefined ? null : loadedDraft(tab);
      if (tab === undefined || source === null || await canonicalSourceHash(source) !== identity.sourceHash) {
        await this.refreshSearchResults();
        return;
      }
      await this.openNote(toNoteId(identity.noteId));
    } else {
      const client = this.vaultClient;
      const serverIdentity = this.identity;
      if (client === null || serverIdentity === null) return;
      const existing = tabById(this.state, identity.noteId);
      const known = this.state.notes.get(identity.noteId);
      if ((existing !== undefined && existing.doc !== null) || known?.sourceHash !== identity.sourceHash) {
        const document = await client.openNote(identity.noteId);
        if (!this.isCurrentVault(serverIdentity, client)) return;
        if (document.meta.sourceHash !== identity.sourceHash) {
          await this.refreshSearchResults();
          return;
        }
        this.state.notes.set(document.meta.noteId, document.meta);
      }
      await this.openNote(toNoteId(identity.noteId));
    }
    const active = activeTab(this.state);
    const source = active === undefined ? null : loadedDraft(active);
    if (source === null || await canonicalSourceHash(source) !== identity.sourceHash) {
      await this.refreshSearchResults();
      return;
    }
    if (hit.sourceRange !== null) {
      this.editor?.revealSelection({ anchor: hit.sourceRange.startUtf16, head: hit.sourceRange.endUtf16 });
    }
    this.state.searchOpen = false;
    this.state.quickOpen = false;
    this.state.commandOpen = false;
    this.state.findOpen = false;
    this.overlayReturn = null;
    this.editor?.focus();
    this.render();
  }

  private searchOverlays(): V2SearchOverlay[] {
    const overlays: V2SearchOverlay[] = [];
    for (const tab of this.state.tabs) {
      const source = loadedDraft(tab);
      if (source === null || !tabIsDirty(tab)) continue;
      if (tab.kind === "saved") {
        const session = tab.session?.state;
        const revision = session !== null && session !== undefined && "base" in session ? session.base.revision : tab.doc?.meta.revision;
        const sourceHash = session !== null && session !== undefined && "base" in session ? session.base.sourceHash : tab.doc?.meta.sourceHash;
        const localRevision = session !== null && session !== undefined && "draft" in session && session.draft !== null ? session.draft.localRevision : 1;
        if (revision === undefined || sourceHash === undefined) continue;
        overlays.push({ kind: "saved", noteId: tab.noteId, baseRevision: revision, baseSourceHash: sourceHash, localRevision, title: tab.title, path: tab.path, content: source });
        continue;
      }
      overlays.push({ kind: "new", localId: tab.localDraftId, localRevision: tab.session?.state.localRevision ?? 0, title: tab.title, path: tab.path, content: source });
    }
    return overlays;
  }

  private isCurrentVault(
    identity: ServerIdentity,
    client: ReturnType<AppServices["api"]["forVault"]>,
  ): boolean {
    return !this.disposed && this.identity?.serverInstanceId === identity.serverInstanceId &&
      this.identity.vaultId === identity.vaultId && this.vaultClient === client;
  }

  private isCurrentTab(
    tab: SavedTab,
    identity: ServerIdentity,
    client: ReturnType<AppServices["api"]["forVault"]>,
  ): boolean {
    return this.isCurrentVault(identity, client) && this.state.tabs.includes(tab) &&
      tab.session?.identity.serverInstanceId === identity.serverInstanceId &&
      tab.session.identity.vaultId === identity.vaultId && tab.session.identity.noteId === tab.noteId;
  }

  private async commandCreate(): Promise<void> {
    const tab = this.localDraftTab(localDraftId(mutationId()), "", "");
    this.state.tabs.push(tab);
    this.state.activeTab = { kind: "local-draft", localDraftId: tab.localDraftId };
    await this.loadLocalDraft(tab);
    if (this.disposed || !this.state.tabs.includes(tab)) return;
    this.state.noteDialog = { kind: "create", localDraftId: tab.localDraftId, title: "" };
    this.render();
  }

  private localDraftTab(id: LocalDraftId, title: string, source: string) {
    const tab: Extract<Tab, { kind: "local-draft" }> = {
      kind: "local-draft",
      key: toTabKey({ kind: "local-draft", localDraftId: id }),
      localDraftId: id,
      title,
      path: "",
      session: null,
      doc: null,
      draft: source,
      dirty: true,
      saving: false,
      savePending: false,
      conflict: false,
      conflictDraftId: null,
      selection: null,
      scrollTop: 0,
      sourceMode: false,
      editorSession: null,
      editorRevision: 0,
    };
    return tab;
  }

  private async promoteLocalDraft(tab: Extract<Tab, { kind: "local-draft" }>, title: string, path: string): Promise<void> {
    if (this.identity === null || this.vaultClient === null || tab.session === null) return;
    if (!tab.session.state.promotionPending) tab.session.editTitle(title);
    else if (tab.session.state.titleDraft !== title) throw new Error("A pending local create cannot change its title");
    const ready = await tab.session.beginPromotion();
    if (!ready || tab.session.state.storage === "failed") {
      throw new Error("Local draft checkpoint failed; export its source before retrying");
    }
    const source = tab.session.exportSource();
    const state = tab.session.state;
    const response = await this.vaultClient.createNote({
      mutationId: state.mutationId,
      path,
      content: source,
      sourceHash: await canonicalSourceHash(source),
    });
    if (response.outcome.state === "pendingMaterialization") {
      this.notify("Note creation is still being applied. Retry the same save to finish promotion.");
      return;
    }
    if (response.outcome.state !== "accepted" || response.outcome.result === null) {
      if (response.outcome.state === "conflict") throw new Error("A new local note unexpectedly conflicted");
      throw new Error("Create response omitted its note metadata");
    }
    const noteMeta = response.outcome.result;
    const document = await this.vaultClient.openNote(noteMeta.noteId);
    const documentIdentity: DocumentIdentity = { ...this.identity, noteId: noteId(noteMeta.noteId) };
    const promoted = await this.services.workspace.promoteLocalDraftCheckpoint(documentIdentity, this.workspaceId, tab.localDraftId, document);
    if (promoted === null) throw new Error("Local draft checkpoint changed before promotion completed");
    const saved = tabFromDocument(document);
    saved.selection = selectionWithin(tab.selection, document.content.length);
    saved.scrollTop = tab.scrollTop;
    saved.sourceMode = tab.sourceMode;
    saved.title = title;
    saved.session = this.createDocumentSession(saved, promoted);
    this.state.notes.set(document.meta.noteId, document.meta);
    const index = this.state.tabs.indexOf(tab);
    if (index !== -1) this.state.tabs.splice(index, 1, saved);
    this.state.activeTab = { kind: "saved", noteId: saved.noteId };
    tab.session = null;
    this.cacheDocument(document);
    this.state.noteDialog = null;
    this.render();
  }

  private createDocumentSession(tab: SavedTab, checkpoint: DraftJournalRecord | null): DocumentSession {
    const serverIdentity = this.identity;
    if (serverIdentity === null) throw new Error("Server identity is unavailable");
    const client = this.vaultClient;
    if (client === null) throw new Error("Vault client is unavailable");
    const identity: DocumentIdentity = { ...serverIdentity, noteId: tab.noteId };
    const journal = this.ensureJournal();
    const services = defaultDocumentSessionServices(
      async (documentIdentity, generation, request) => ({
        identity: documentIdentity,
        generation,
        response: await client.saveNote(documentIdentity.noteId, request),
      }),
      this.services.workspace.checkpointWriter(journal),
      this.services.workspace.checkpointClearer(journal, this.workspaceId),
    );
    services.clearTitleCheckpoint = this.services.workspace.titleCheckpointClearer(journal, this.workspaceId);
    const session = new DocumentSession(identity, ++this.sessionGeneration, this.workspaceId, services);
    tab.session = session;
    session.subscribe((value) => this.onDocumentSessionState(tab, session, serverIdentity, client, value));
    if (tab.doc !== null && checkpoint !== null) session.recover(tab.doc, checkpoint);
    else if (tab.doc !== null) {
      tab.selection = selectionWithin(tab.selection, tab.doc.content.length);
      session.loaded(tab.doc, tab.selection);
    }
    return session;
  }

  private async submitNoteDialog(value?: string): Promise<void> {
    const dialog = this.state.noteDialog;
    if (dialog === null) return;
    if (dialog.kind === "create") {
      const title = (value ?? dialog.title).trim();
      if (title === "") return;
      const candidate = this.state.tabs.find((item) => item.kind === "local-draft" && item.localDraftId === dialog.localDraftId);
      if (candidate?.kind !== "local-draft") return;
      const tab = candidate;
      const path = uniqueNotePath(title, this.state.notes.values());
      tab.title = title;
      tab.path = path;
      await this.promoteLocalDraft(tab, title, path);
    } else if (dialog.kind === "rename") {
      const tab = tabById(this.state, dialog.noteId);
      const title = (value ?? dialog.title).trim();
      if (tab?.session === null || tab === undefined || title === "") return;
      const session = tab.session;
      session.editTitle(title);
      const status = session.state;
      if (!("base" in status) || status.titleMutationId === null) return;
      const path = renamedPath(tab.path, title, this.state.notes.values(), tab.noteId);
      const response = await this.vaultClient!.renameNote(tab.noteId, {
        mutationId: status.titleMutationId,
        precondition: { baseRevision: status.base.revision, baseSourceHash: status.base.sourceHash, baseDiskHash: status.base.diskHash },
        path,
      });
      if (response.outcome.state !== "accepted" || response.outcome.result === null) throw new Error("Rename was not accepted");
      await session.acceptRename(response.outcome.result, status.titleRevision, status.titleMutationId);
      tab.title = title;
      tab.path = response.outcome.result.path;
      tab.doc = { ...tab.doc!, meta: response.outcome.result };
      this.state.notes.set(tab.noteId, response.outcome.result);
      this.state.noteDialog = null;
      this.persistWorkspace();
      this.render();
    } else if (dialog.kind === "tag") {
      const tab = activeTab(this.state);
      const tag = normalizeTag(value ?? dialog.value);
      if (tab?.kind === "saved" && tag !== null) this.editor?.updateTags([...new Set([...(tab.doc?.meta.tags ?? []), tag])]);
      this.state.noteDialog = null;
      this.render();
    } else {
      await this.deleteNote(dialog.noteId);
    }
  }

  private async deleteNote(id: ReturnType<typeof toNoteId>): Promise<void> {
    const tab = tabById(this.state, id);
    const status = tab?.session?.state;
    if (tab === undefined || status === undefined || !("base" in status)) return;
    const response = await this.vaultClient!.deleteNote(id, {
      mutationId: mutationId(),
      precondition: { baseRevision: status.base.revision, baseSourceHash: status.base.sourceHash, baseDiskHash: status.base.diskHash },
    });
    if (response.outcome.state !== "accepted") throw new Error("Delete was not accepted");
    this.state.notes.delete(id);
    this.state.pinned.delete(id);
    this.state.recent = this.state.recent.filter((item) => item !== id);
    this.state.noteDialog = null;
    this.render();
    await this.services.workspace.deleteCachedNoteBodies({ ...this.identity!, noteId: id });
    await this.closeTab({ kind: "saved", noteId: id }, false);
  }

  private async renameDialog(id: ReturnType<typeof toNoteId>): Promise<void> {
    const tab = tabById(this.state, id);
    if (tab === undefined) return;
    this.state.noteDialog = { kind: "rename", noteId: id, title: tab.title };
    this.render();
  }

  private async togglePin(id: ReturnType<typeof toNoteId>): Promise<void> {
    if (this.state.pinned.has(id)) this.state.pinned.delete(id);
    else this.state.pinned.add(id);
    this.persistWorkspace();
    this.render();
  }

  private async commandRevisions(): Promise<void> {
    const tab = activeTab(this.state);
    const identity = this.identity;
    const client = this.vaultClient;
    if (tab?.kind !== "saved" || identity === null || client === null) return;
    this.state.revisionsOpen = true;
    this.state.revisionNoteId = tab.noteId;
    this.state.revisionList = null;
    this.state.revisionDocument = null;
    const revisions = await client.listRevisions(tab.noteId);
    if (!this.isCurrentVault(identity, client) || activeTab(this.state) !== tab || this.state.revisionNoteId !== tab.noteId) return;
    this.state.revisionList = revisions;
    this.render();
  }

  private async selectRevision(revision: number): Promise<void> {
    const tab = activeTab(this.state);
    const identity = this.identity;
    const client = this.vaultClient;
    if (tab?.kind !== "saved" || identity === null || client === null || this.state.revisionNoteId !== tab.noteId ||
      !this.state.revisionList?.some((item) => item.noteId === tab.noteId && item.revision === revision)) return;
    const document = await client.openRevision(tab.noteId, revision);
    if (!this.isCurrentVault(identity, client) || activeTab(this.state) !== tab || this.state.revisionNoteId !== tab.noteId ||
      document.revision.noteId !== tab.noteId || document.revision.revision !== revision) return;
    this.state.revisionDocument = document;
    this.render();
  }

  private async restoreSelectedRevision(): Promise<void> {
    const tab = activeTab(this.state);
    const selected = this.state.revisionDocument;
    const status = tab?.kind === "saved" ? tab.session?.state : undefined;
    const identity = this.identity;
    const client = this.vaultClient;
    if (tab?.kind !== "saved" || selected === null || selected.revision.noteId !== tab.noteId ||
      this.state.revisionNoteId !== tab.noteId || status === undefined || !("base" in status) ||
      identity === null || client === null) return;
    const response = await client.restoreRevision(tab.noteId, selected.revision.revision, {
      mutationId: mutationId(),
      precondition: { baseRevision: status.base.revision, baseSourceHash: status.base.sourceHash, baseDiskHash: status.base.diskHash },
    });
    await this.handleMutation(response, tab, status.draft.localRevision);
    if (this.isCurrentVault(identity, client) && activeTab(this.state) === tab && this.state.revisionNoteId === tab.noteId) {
      this.state.revisionsOpen = false;
    }
  }

  private async viewConflictDraft(): Promise<void> {
    const tab = activeTab(this.state);
    const status = tab?.kind === "saved" ? tab.session?.state : undefined;
    if (tab?.kind !== "saved" || status?.status !== "conflict" || status.conflictDraft === null || this.vaultClient === null) return;
    this.state.conflictDraft = await this.vaultClient.openConflictDraft(tab.noteId, status.conflictDraft.draftId);
    this.render();
  }

  private async restoreConflictDraft(): Promise<void> {
    const tab = activeTab(this.state);
    const status = tab?.kind === "saved" ? tab.session?.state : undefined;
    if (tab?.kind !== "saved" || status?.status !== "conflict" || status.conflictDraft === null || this.state.conflictDraft === null) return;
    const response = await this.vaultClient!.restoreConflictDraft(tab.noteId, status.conflictDraft.draftId, {
      mutationId: mutationId(),
      precondition: { baseRevision: status.base.revision, baseSourceHash: status.base.sourceHash, baseDiskHash: status.base.diskHash },
    });
    await this.handleMutation(response, tab, status.draft.localRevision);
    this.state.conflictDraft = null;
  }

  private async handleMutation(response: V2MutationResponse, tab: SavedTab, expectedLocalRevision: number): Promise<void> {
    if (response.outcome.state === "accepted") {
      if (response.outcome.result === null) throw new Error("Accepted restore response omitted note metadata");
      const document = await this.vaultClient!.openNote(tab.noteId);
      tab.doc = document;
      const sessionState = tab.session?.state;
      const matchesRevision = sessionState !== undefined && "draft" in sessionState &&
        sessionState.draft !== null && sessionState.draft.localRevision === expectedLocalRevision;
      if (matchesRevision && tab.editorSession !== null) {
        const snapshot = this.activeEditorKey === tab.key ? this.editor?.getSnapshot() : null;
        const editorRevision = snapshot?.noteId === tab.key ? snapshot.revision : tab.editorRevision;
        if (this.editor?.markSaved(tab.editorSession, editorRevision)) {
          this.editor.reloadIfClean(tab.editorSession, document.content);
        }
      }
      tab.session?.applyAcceptedMutation(document, expectedLocalRevision);
      this.state.notes.set(tab.noteId, document.meta);
      this.cacheDocument(document);
    } else if (response.outcome.state === "conflict") {
      tab.session?.reconcile(response.outcome.current);
      tab.doc = response.outcome.current;
      tab.conflict = true;
    }
    this.render();
  }

  private async saveSettings(settings: { excludedFoldersText: string; autosaveDelayMs: number; undoStackMax: number; imageWebpQuality: number }): Promise<void> {
    const current = this.state.boot?.settings;
    if (current === undefined || this.vaultClient === null) return;
    const next: Settings = {
      ...current,
      excludedFolders: settings.excludedFoldersText.split(",").map((value) => value.trim()).filter(Boolean),
      autosaveDelayMs: Number.isFinite(settings.autosaveDelayMs)
        ? Math.max(150, settings.autosaveDelayMs)
        : current.autosaveDelayMs,
      undoStackMax: Number.isFinite(settings.undoStackMax)
        ? Math.max(20, settings.undoStackMax)
        : current.undoStackMax,
      imageWebpQuality: Number.isFinite(settings.imageWebpQuality)
        ? Math.min(1, Math.max(0.1, settings.imageWebpQuality))
        : current.imageWebpQuality,
    };
    const response = await this.vaultClient.saveSettings({ mutationId: mutationId(), settings: next });
    if (this.state.boot !== null) this.state.boot.settings = response.settings;
    this.state.settingsOpen = false;
    this.render();
  }

  private async importHtml(): Promise<void> {
    const imported = await this.services.htmlImport.pickHtmlImport(this.state.notes.values());
    if (imported === null) return;
    const tab = this.localDraftTab(localDraftId(mutationId()), imported.path.replace(/\.md$/i, ""), imported.content);
    tab.path = imported.path;
    this.state.tabs.push(tab);
    this.state.activeTab = tabIdentity(tab);
    await this.loadLocalDraft(tab);
    await this.promoteLocalDraft(tab, tab.title, imported.path);
  }

  private dispatch(event: ViewEvent): void {
    if (this.disposed || this.transitioningVault && event.type !== "vault.switch") return;
    switch (event.type) {
      case "vault.switch": {
        this.runAsync(this.boot(event.vaultId), "Load failed", false);
        return;
      }
      case "search.input": {
        this.state.searchQuery = event.query;
        this.runAsync(this.updateSearch(), "Search failed");
        return;
      }
      case "search.open": {
        this.captureOverlayReturn();
        this.state.searchOpen = true;
        this.state.quickOpen = false;
        this.state.findOpen = false;
        this.state.commandOpen = false;
        this.state.searchOverlayQuery = "";
        this.render();
        return;
      }
      case "search.overlayInput": {
        this.state.searchOverlayQuery = event.query;
        this.runAsync(this.updateSearchOverlay(), "Search failed");
        return;
      }
      case "search.hitOpen": {
        this.runAsync(this.openSearchHit(event.hit), "Search result could not be opened");
        return;
      }
      case "quickOpen.open": {
        this.captureOverlayReturn();
        this.state.quickOpen = true;
        this.state.searchOpen = false;
        this.state.findOpen = false;
        this.state.commandOpen = false;
        this.state.quickOpenQuery = "";
        this.state.quickOpenHits = null;
        this.runAsync(this.updateQuickOpen(), "Quick open failed");
        this.render();
        return;
      }
      case "quickOpen.input": {
        this.state.quickOpenQuery = event.query;
        this.runAsync(this.updateQuickOpen(), "Quick open failed");
        return;
      }
      case "quickOpen.hitOpen": {
        this.runAsync(this.openQuickOpenHit(event.hit), "Quick-open result could not be opened");
        return;
      }
      case "find.open": {
        this.captureOverlayReturn();
        this.state.findOpen = true;
        this.state.searchOpen = false;
        this.state.quickOpen = false;
        this.state.commandOpen = false;
        this.render();
        return;
      }
      case "find.input": {
        this.state.findQuery = event.query;
        this.render();
        return;
      }
      case "find.select": {
        this.editor?.revealFindMatch(event.match);
        this.state.findOpen = false;
        this.overlayReturn = null;
        this.render();
        this.editor?.focus();
        return;
      }
      case "outline.select": {
        this.editor?.revealSelection({ anchor: event.heading.from, head: event.heading.from });
        return;
      }
      case "sidebar.toggle": {
        this.state.sidebarCollapsed = !this.state.sidebarCollapsed;
        this.render();
        return;
      }
      case "outline.toggle": {
        this.state.outlineCollapsed = !this.state.outlineCollapsed;
        this.render();
        return;
      }
      case "auth.capability": {
        this.state.authCapability = event.value;
        return;
      }
      case "auth.login": {
        this.runAsync(this.performPasskeyAction("login"), "Sign in failed", false);
        return;
      }
      case "auth.enroll": {
        this.runAsync(this.performPasskeyAction("enroll"), "Passkey registration failed", false);
        return;
      }
      case "auth.logout": {
        this.runAsync(this.logout(), "Lock session failed", false);
        return;
      }
      case "storage.persist": {
        this.runAsync(this.requestPersistentStorage(), "Storage permission request failed");
        return;
      }
      case "command.open": {
        this.captureOverlayReturn();
        this.state.commandOpen = true;
        this.state.searchOpen = false;
        this.state.quickOpen = false;
        this.state.findOpen = false;
        this.state.commandFilter = "";
        this.render();
        return;
      }
      case "command.filter": {
        this.state.commandFilter = event.query;
        this.render();
        return;
      }
      case "command.run": {
        this.executeCommand(event.id);
        return;
      }
      case "dialog.input": {
        const dialog = this.state.noteDialog;
        if (dialog?.kind === "create" || dialog?.kind === "rename") {
          dialog.title = event.value;
          if (dialog.kind === "rename") tabById(this.state, dialog.noteId)?.session?.editTitle(event.value);
          if (dialog.kind === "create") this.state.tabs.find((tab) => tab.kind === "local-draft" && tab.localDraftId === dialog.localDraftId)?.session?.editTitle(event.value);
        } else if (dialog?.kind === "tag") dialog.value = event.value;
        return;
      }
      case "dialog.submit": {
        this.runAsync(this.submitNoteDialog(event.value), "Action failed");
        return;
      }
      case "settings.submit": {
        this.runAsync(this.saveSettings(event.settings), "Settings failed");
        return;
      }
      case "overlay.close": {
        this.runAsync(this.closeOverlays(), "Local recovery storage failed");
        return;
      }
      case "context.close": {
        this.state.contextMenu = null;
        this.render();
        return;
      }
      case "context.open": {
        this.state.contextMenu = { noteId: event.noteId, x: event.x, y: event.y };
        this.render();
        return;
      }
      case "tab.activate": {
        this.runAsync(this.activateTab(event.tab), "Open failed");
        return;
      }
      case "tab.close": {
        this.runAsync(this.closeTab(event.tab), "Close failed");
        return;
      }
      case "note.open": {
        this.runAsync(this.openNote(event.noteId), "Open failed");
        return;
      }
      case "note.retry": {
        this.runAsync(this.retryNote(event.noteId), "Retry failed");
        return;
      }
      case "localDraft.open": {
        this.runAsync(this.openLocalDraft(event.localDraftId), "Open failed");
        return;
      }
      case "note.rename": {
        const current = activeTab(this.state);
        const id = event.noteId ?? (current?.kind === "saved" ? current.noteId : undefined);
        if (id !== undefined) this.runAsync(this.renameDialog(id), "Rename failed");
        return;
      }
      case "note.delete": {
        const current = activeTab(this.state);
        const id = event.noteId ?? (current?.kind === "saved" ? current.noteId : undefined);
        if (id !== undefined) { this.state.noteDialog = { kind: "delete", noteId: id }; this.render(); }
        return;
      }
      case "note.pin": {
        const current = activeTab(this.state);
        const id = event.noteId ?? (current?.kind === "saved" ? current.noteId : undefined);
        if (id !== undefined) this.runAsync(this.togglePin(id), "Pin failed");
        return;
      }
      case "note.addTag": {
        this.state.noteDialog = { kind: "tag", value: "" };
        this.render();
        return;
      }
      case "tags.update": {
        this.editor?.updateTags(event.tags);
        return;
      }
      case "reading.toggle": {
        this.state.readingMode = !this.state.readingMode;
        this.render();
        return;
      }
      case "editor.toolbar": {
        this.dispatchEditorToolbar(event.command);
        return;
      }
      case "revisions.open": {
        this.runAsync(this.commandRevisions(), "Revisions failed");
        return;
      }
      case "revisions.select": {
        this.runAsync(this.selectRevision(event.eventId), "Revision failed");
        return;
      }
      case "revisions.restore": {
        this.runAsync(this.restoreSelectedRevision(), "Restore failed");
        return;
      }
      case "conflict.view": {
        this.runAsync(this.viewConflictDraft(), "Conflict draft failed");
        return;
      }
      case "conflict.restore": {
        this.runAsync(this.restoreConflictDraft(), "Restore failed");
        return;
      }
      case "draft.export": {
        this.exportActiveDraft();
        return;
      }
      case "draft.recreate": {
        this.runAsync(this.recreateUnavailableDraft(), "Recreate failed");
        return;
      }
      case "render.request": {
        this.render();
        return;
      }
    }
  }

  private executeCommand(id: CommandId): void {
    this.state.commandOpen = false;
    this.render();
    if (["save", "pin", "reopen", "reading", "import", "source"].includes(id)) this.restoreOverlayReturn();
    switch (id) {
      case "create": {
        this.runAsync(this.commandCreate(), "Create failed");
        break;
      }
      case "open": {
        this.dispatch({ type: "quickOpen.open" });
        break;
      }
      case "save": {
        this.runAsync(this.manualSave(), "Save failed");
        break;
      }
      case "rename": {
        const tab = activeTab(this.state);
        if (tab?.kind === "saved") this.runAsync(this.renameDialog(tab.noteId), "Rename failed");
        break;
      }
      case "delete": {
        const tab = activeTab(this.state);
        if (tab?.kind === "saved") this.dispatch({ type: "note.delete", noteId: tab.noteId });
        break;
      }
      case "pin": {
        const tab = activeTab(this.state);
        if (tab?.kind === "saved") this.runAsync(this.togglePin(tab.noteId), "Pin failed");
        break;
      }
      case "reopen": {
        this.reopenClosed();
        break;
      }
      case "reading": {
        this.state.readingMode = !this.state.readingMode;
        this.render();
        break;
      }
      case "search": {
        this.dispatch({ type: "search.open" });
        break;
      }
      case "find": {
        this.dispatch({ type: "find.open" });
        break;
      }
      case "import": {
        this.runAsync(this.importHtml(), "Import failed");
        break;
      }
      case "revisions": {
        this.runAsync(this.commandRevisions(), "Revisions failed");
        break;
      }
      case "settings": {
        this.state.settingsOpen = true;
        this.render();
        break;
      }
      case "source": {
        this.toggleSourceMode();
        break;
      }
    }
  }

  private reopenClosed(): void {
    const closed = this.state.closedTabs.shift();
    if (closed === undefined) return;
    const tab = tabFromWorkspace(closed);
    this.state.tabs.push(tab);
    this.runAsync(this.activateTab(tabIdentity(tab)), "Open failed");
  }

  private dispatchEditorToolbar(command: EditorToolbarCommand): void {
    if (command === "source") this.toggleSourceMode();
    else if (command === "save") this.runAsync(this.manualSave(), "Save failed");
    else if (command === "undo") this.editor?.undo();
    else if (command === "redo") this.editor?.redo();
    else this.editor?.formatSelection(command);
  }

  private toggleSourceMode(): void {
    const tab = activeTab(this.state);
    if (tab === undefined) return;
    tab.sourceMode = !tab.sourceMode;
    this.editor?.setMode(tab.sourceMode ? "source" : "live");
    this.persistWorkspace();
    this.render();
  }

  private async prefetchAssets(tab: Tab, source: string): Promise<void> {
    const hadScopedAssets = this.assetScope.size > 0;
    this.cancelAssetScope();
    if (hadScopedAssets) this.editor?.updateConfiguration(this.editorConfig());
    const controller = new AbortController();
    this.assetController = controller;
    const key = tab.key;
    const generation = this.bootGeneration;
    const names = new Set(
      [...source.matchAll(/(?:^|\[|\(|\/)((?:\/?z-images\/)[^\s)"'>\]|]+)/g)]
        .map((match) => match[1]!.replace(/^\//, "")),
    );
    if (this.vaultClient === null) return;
    for (const name of names) {
      try {
        const blob = await this.vaultClient.loadAsset(name, controller.signal);
        if (controller.signal.aborted || generation !== this.bootGeneration || activeTab(this.state)?.key !== key) return;
        this.assetScope.set(name, URL.createObjectURL(blob));
        this.assetScopeRevision += 1;
        this.editor?.updateConfiguration(this.editorConfig());
      } catch (error) {
        if (!controller.signal.aborted) logClientEvent("warn", "client.asset", { error: errorSummary(error) });
      }
    }
  }

  private resolveAssetUrl(name: string): string | null {
    const normalized = name.startsWith("/") ? name.slice(1) : name;
    return this.assetScope.get(normalized) ?? null;
  }

  private cancelAssetScope(): void {
    this.assetController?.abort();
    this.assetController = null;
    if (this.assetScope.size > 0) this.assetScopeRevision += 1;
    for (const url of this.assetScope.values()) URL.revokeObjectURL(url);
    this.assetScope.clear();
  }

  private ensureJournal() {
    if (this.journal !== null) return this.journal;
    this.journal = this.services.workspace.createJournal((error) => this.notifyStorageFailure(error));
    this.detachVisibilityFlush = this.services.workspace.attachVisibilityFlush(this.journal);
    return this.journal;
  }

  private cacheDocument(document: V2NoteDocument): void {
    const serverIdentity = this.identity;
    const client = this.vaultClient;
    if (serverIdentity === null || client === null) return;
    const identity: DocumentIdentity = { ...serverIdentity, noteId: noteId(document.meta.noteId) };
    const write = this.services.workspace.cacheNoteBody(identity, document).catch((error) => {
      if (this.isCurrentVault(serverIdentity, client)) this.notifyStorageFailure(error);
    });
    this.trackAction(write);
  }

  private touchRecent(id: string): void {
    if (!this.state.notes.has(id)) return;
    this.state.recent = [id, ...this.state.recent.filter((item) => item !== id)].slice(0, 50);
    this.scheduleWorkspaceSave();
  }

  private filteredCommands() {
    return commandItems(this.state);
  }

  private viewActions(): ViewActions {
    return {
      dispatch: (event) => this.dispatch(event),
      commandItems: () => this.filteredCommands(),
      findMatches: () => this.editor?.find(this.state.findQuery) ?? [],
      outline: () => this.editor?.outline() ?? { headings: [], complete: true },
    };
  }

  private notify(message: string): void {
    if (this.disposed) return;
    this.state.notice = message;
    this.render();
    if (this.noticeTimer !== undefined) window.clearTimeout(this.noticeTimer);
    this.noticeTimer = window.setTimeout(() => {
      this.noticeTimer = undefined;
      if (this.state.notice === message) {
        this.state.notice = null;
        this.render();
      }
    }, 2400);
  }

  private notifyStorageFailure(error: unknown): void {
    logClientEvent("error", "client.storage", { error: errorSummary(error) });
    this.notify("Local recovery storage failed. Export your draft before closing this tab.");
  }

  private exportActiveDraft(): void {
    const tab = activeTab(this.state);
    if (tab === undefined) return;
    const source = tab.kind === "local-draft"
      ? tab.session?.exportSource() ?? tab.draft
      : tab.session === null ? tab.draft : tab.session.exportSource();
    if (source === null) return;
    const filename = (tab.path || `${tab.title || "untitled"}.md`).replace(/[\\/?%*:|"<>]/g, "-");
    const url = URL.createObjectURL(new Blob([source], { type: "text/markdown;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  private async recreateUnavailableDraft(): Promise<void> {
    const original = activeTab(this.state);
    if (original?.kind !== "saved" || original.session?.state.status !== "unavailable" ||
      original.session.state.reason.kind !== "unresolved" || original.session.state.draft === null ||
      this.identity === null) return;
    const recovered = original.session.state.draft;
    const local = this.localDraftTab(localDraftId(mutationId()), original.title, recovered.source);
    local.path = original.path;
    local.selection = recovered.selection;
    const index = this.state.tabs.indexOf(original);
    this.state.tabs.splice(index + 1, 0, local);
    this.state.activeTab = tabIdentity(local);
    await this.loadLocalDraft(local);
    const copied = await local.session!.persist();
    if (!copied) throw new Error("Could not checkpoint recreated draft locally");
    const cleared = await this.services.workspace.checkpointClearer(
      this.ensureJournal(),
      this.workspaceId,
    )({ ...this.identity, noteId: original.noteId }, recovered.localRevision, recovered.mutationId);
    if (!cleared) {
      this.notify("The original recovery copy changed; both drafts are preserved.");
      return;
    }
    original.session.close();
    this.state.tabs.splice(this.state.tabs.indexOf(original), 1);
    this.render();
  }

  private runAsync(promise: Promise<unknown>, message: string, track = true): void {
    const handled = promise.catch((error: unknown) => {
      if (error instanceof V2ApiError && error.kind?.code === "auth_required") {
        void this.lockForAuthentication();
        return;
      }
      logClientEvent("error", "client.error", { error: errorSummary(error), message });
      this.notify(message);
    });
    if (track) this.trackAction(handled);
    else void handled;
  }

  private async closeOverlays(): Promise<void> {
    const dialog = this.state.noteDialog;
    if (dialog?.kind === "rename") tabById(this.state, dialog.noteId)?.session?.editTitle(null);
    this.state.commandOpen = false;
    this.state.searchOpen = false;
    this.state.quickOpen = false;
    this.state.findOpen = false;
    this.state.revisionsOpen = false;
    this.state.settingsOpen = false;
    this.state.conflictDraft = null;
    this.state.noteDialog = null;
    this.state.contextMenu = null;
    this.render();
    this.restoreOverlayReturn();
    if (dialog?.kind === "rename") await this.journal?.flushAll();
  }

  private hasOverlay(): boolean {
    return this.state.commandOpen || this.state.searchOpen || this.state.quickOpen || this.state.findOpen || this.state.revisionsOpen || this.state.settingsOpen || this.state.conflictDraft !== null || this.state.noteDialog !== null || this.state.contextMenu !== null;
  }

  private captureOverlayReturn(): void {
    if (this.overlayReturn !== null) return;
    const element = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const tab = activeTab(this.state);
    const snapshot = this.editor?.getSnapshot();
    this.overlayReturn = {
      element,
      tab,
      editorFocused: element !== null && this.editorMount.contains(element),
      selection: snapshot?.selection ?? tab?.selection ?? null,
    };
  }

  private restoreOverlayReturn(): void {
    const target = this.overlayReturn;
    this.overlayReturn = null;
    if (target === null) return;
    if (target.editorFocused && target.tab !== undefined && activeTab(this.state) === target.tab && target.selection !== null) {
      this.editor?.revealSelection(target.selection);
      this.editor?.focus();
      return;
    }
    if (target.element?.isConnected) target.element.focus();
  }

  private async performPasskeyAction(action: "login" | "enroll"): Promise<void> {
    if (this.state.authBusy !== null) return;
    const capability = action === "enroll" && this.state.authRequired
      ? this.state.authCapability.trim()
      : undefined;
    this.state.authBusy = action;
    this.state.authError = null;
    this.render();
    try {
      if (action === "login") await this.services.passkeys.login();
      else await this.services.passkeys.enroll(capability === "" ? undefined : capability);
      this.state.authCapability = "";
      this.state.authRequired = false;
      if (this.state.boot === null) await this.boot();
      else this.notify("Passkey registered");
    } catch (error) {
      this.state.authError = error instanceof Error ? error.message : String(error);
    } finally {
      this.state.authBusy = null;
      this.render();
    }
  }

  private async logout(): Promise<void> {
    if (this.state.authBusy !== null) return;
    this.state.authBusy = "logout";
    this.transitioningVault = true;
    this.configureActiveEditor(true);
    this.render();
    try {
      await this.drainInFlightActions();
      if (this.identity !== null) await this.flushOutgoingWorkspace(this.identity);
      await this.services.passkeys.logout();
      this.eventSubscription?.close();
      this.eventSubscription = null;
      this.cancelAutoSaves();
      this.transitioningVault = false;
      this.state.boot = null;
      this.state.authRequired = true;
      this.state.authError = null;
      this.render();
    } catch (error) {
      this.transitioningVault = false;
      this.configureActiveEditor(false);
      throw error;
    } finally {
      this.state.authBusy = null;
      this.render();
    }
  }

  private async lockForAuthentication(): Promise<void> {
    if (this.disposed || this.state.authRequired) return;
    this.captureActiveEditor();
    const identity = this.identity;
    const pending = identity === null ? Promise.resolve() : this.flushOutgoingWorkspace(identity);
    this.state.authRequired = true;
    this.state.authBusy = null;
    this.state.authError = null;
    this.state.boot = null;
    this.state.searchOpen = false;
    this.state.quickOpen = false;
    this.state.findOpen = false;
    this.state.commandOpen = false;
    this.state.revisionsOpen = false;
    this.state.settingsOpen = false;
    this.state.conflictDraft = null;
    this.state.noteDialog = null;
    this.state.contextMenu = null;
    this.eventSubscription?.close();
    this.eventSubscription = null;
    this.cancelAutoSaves();
    this.transitioningVault = false;
    this.render();
    try {
      await pending;
    } catch (error) {
      this.state.authError = `Recovery state could not be flushed: ${error instanceof Error ? error.message : String(error)}`;
      this.render();
    }
  }

  private async requestPersistentStorage(): Promise<void> {
    this.state.storagePersisted = await this.services.storage.requestPersistent();
    this.render();
  }

}

function uniqueNotePath(title: string, notes: Iterable<{ path: string }>): string {
  const base = slugifyTitle(title);
  const existing = new Set([...notes].map((note) => note.path.toLowerCase()));
  for (let index = 1; ; index += 1) {
    const suffix = index === 1 ? "" : `-${index}`;
    const path = `${base}${suffix}.md`;
    if (!existing.has(path.toLowerCase())) return path;
  }
}

function renamedPath(currentPath: string, title: string, notes: Iterable<V2NoteMeta>, except: string): string {
  const slash = currentPath.lastIndexOf("/");
  const directory = slash === -1 ? "" : currentPath.slice(0, slash + 1);
  const base = slugifyTitle(title);
  const existing = new Set([...notes].filter((note) => note.noteId !== except).map((note) => note.path.toLowerCase()));
  for (let index = 1; ; index += 1) {
    const suffix = index === 1 ? "" : `-${index}`;
    const path = `${directory}${base}${suffix}.md`;
    if (!existing.has(path.toLowerCase())) return path;
  }
}

function slugifyTitle(title: string): string {
  return title.trim().toLowerCase().replaceAll(/["']/g, "").replaceAll(/[^a-z0-9]+/g, "-").replaceAll(/^-+|-+$/g, "") || "untitled";
}

function identityOfWorkspace(tab: WorkspaceState["tabs"][number]): TabIdentity {
  return tab.kind === "saved" ? { kind: "saved", noteId: toNoteId(tab.noteId) } : tab;
}

function identityOfWorkspaceIdentity(tab: NonNullable<WorkspaceState["activeTab"]>): TabIdentity {
  return tab.kind === "saved" ? { kind: "saved", noteId: toNoteId(tab.noteId) } : tab;
}

function mutationId(): string {
  const value = globalThis.crypto?.randomUUID();
  if (value === undefined) throw new Error("Secure random mutation identity is unavailable");
  return value;
}

function selectionWithin(selection: SavedTab["selection"], sourceLength: number): SavedTab["selection"] {
  if (selection === null) return null;
  return {
    anchor: Math.max(0, Math.min(sourceLength, selection.anchor)),
    head: Math.max(0, Math.min(sourceLength, selection.head)),
  };
}

function sameSelection(left: { anchor: number; head: number } | null, right: { anchor: number; head: number } | null): boolean {
  return left?.anchor === right?.anchor && left?.head === right?.head;
}

function errorSummary(error: unknown): Record<string, unknown> {
  return error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { message: String(error) };
}

export function startApp(root: HTMLElement): TansuApp {
  const app = new TansuApp(root);
  app.bindGlobalEvents();
  void app.boot().catch((error: unknown) => {
    logClientEvent("error", "client.error", { error: errorSummary(error), message: "Load failed" });
    root.replaceChildren(renderLoading());
  });
  return app;
}
