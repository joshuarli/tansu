import { stemFromPath } from "@joshuarli98/md-wysiwyg";
import { ErrorBoundary, createEffect, createSignal, onCleanup, onMount } from "solid-js";

import {
  createNote,
  getStatus,
  listNotes,
  type AppStatus,
  unlockWithPrf,
  unlockWithRecoveryKey,
} from "./api.ts";
import {
  bootApp,
  checkBrowserSupport,
  showUnlockScreen as renderUnlockScreen,
  showUnsupportedPage,
} from "./bootstrap.ts";
import { MIN_SUPPORTED_FIREFOX_VERSION } from "./constants.ts";
import { createEditorShellRefs, EditorShell } from "./editor-shell.tsx";
import { initEditor, invalidateNoteCache, type EditorInstance } from "./editor.ts";
import { Sidebar } from "./filenav.tsx";
import { initInputDialog } from "./input-dialog.tsx";
import { openStore } from "./local-store.ts";
import { matchesKey, PaletteModal, type Command } from "./palette.tsx";
import { SearchModal } from "./search.tsx";
import { serverStore } from "./server-store.ts";
import { SettingsModal } from "./settings.tsx";
import {
  closeActiveTab,
  getActiveTab,
  nextTab,
  openTab,
  prevTab,
  reopenClosedTab,
  restoreSession,
  syncToServer,
  useTabs,
} from "./tab-state.ts";
import { promptNewNote, TabBarShell } from "./tabs.tsx";
import { uiStore } from "./ui-store.ts";
import { isPrfLikelySupported, getPrfKey } from "./webauthn.ts";
import { registerWikiLinkClickHandler } from "./wikilinks.ts";

type AppProps = {
  appEl: HTMLElement;
};

export function App(props: Readonly<AppProps>) {
  let inputDialogOverlayRef!: HTMLDivElement;
  let emptyStateRef!: HTMLDivElement;

  const shellRefs = createEditorShellRefs();
  const [editorVisible, setEditorVisible] = createSignal(false);
  const [editorTags, setEditorTags] = createSignal<readonly string[]>([]);
  const [editorSourceMode, setEditorSourceMode] = createSignal(false);
  const [commands, setCommands] = createSignal<readonly Command[]>([]);
  const tabs = useTabs();

  onMount(() => {
    let appInitialized = false;
    let editor: EditorInstance | null = null;

    function showUnlockScreen(status?: AppStatus) {
      renderUnlockScreen({
        appEl: props.appEl,
        ...(status ? { status } : {}),
        isPrfLikelySupported,
        getPrfKey,
        unlockWithPrf,
        unlockWithRecoveryKey,
        onUnlocked: () => {
          void startApp();
        },
      });
    }

    function initApp() {
      initInputDialog(inputDialogOverlayRef);
      editor = initEditor({
        emptyState: emptyStateRef,
        shellRefs,
        setTags: (tags) => setEditorTags([...tags]),
        setSourceMode: setEditorSourceMode,
        setVisible: setEditorVisible,
      });

      registerWikiLinkClickHandler(async (target: string) => {
        const notes = await listNotes();
        const normalized = target.toLowerCase().replaceAll(/\s+/g, "-");
        const match = notes.find((note) => {
          const stem = stemFromPath(note.path).toLowerCase().replaceAll(/\s+/g, "-");
          return stem === normalized;
        });

        if (match) {
          await openTab(match.path);
          return;
        }

        const path = `${target}.md`;
        await createNote(path);
        invalidateNoteCache();
        await openTab(path);
      });

      serverStore.configure({
        invalidateNoteCache,
        getActivePath: () => getActiveTab()?.path ?? null,
        reloadActiveNote: (content, mtime) => {
          editor?.reloadFromDisk(content, mtime);
        },
        closeActiveTab,
        syncSessionToServer: syncToServer,
        refreshVaultSwitcher: async () => undefined,
        showUnlockScreen: () => showUnlockScreen(),
      });

      setCommands([
        {
          label: "Search notes",
          shortcut: "⌘K",
          keys: { key: "k", meta: true },
          action: () => uiStore.openSearch(),
        },
        {
          label: "Search in current note",
          shortcut: "⌘F",
          keys: { key: "f", meta: true },
          action: () => {
            const tab = getActiveTab();
            uiStore.openSearch(tab?.path);
          },
        },
        {
          label: "Global search",
          shortcut: "⇧⌘F",
          keys: { key: "f", meta: true, shift: true },
          action: () => uiStore.openSearch(),
        },
        {
          label: "New note",
          shortcut: "⌘N",
          keys: { key: "n", meta: true },
          action: () => {
            void promptNewNote();
          },
        },
        {
          label: "Reopen closed tab",
          shortcut: "⇧⌘T",
          keys: { key: "t", meta: true, shift: true },
          action: () => {
            void reopenClosedTab();
          },
        },
        {
          label: "Save",
          shortcut: "⌘S",
          keys: { key: "s", meta: true },
          action: () => {
            void editor?.saveCurrentNote();
          },
        },
        {
          label: "Close tab",
          shortcut: "⌘W",
          keys: { key: "w", meta: true },
          action: () => closeActiveTab(),
        },
        {
          label: "Next tab",
          shortcut: "⇧⌘]",
          keys: { key: "]", meta: true, shift: true },
          action: () => nextTab(),
        },
        {
          label: "Previous tab",
          shortcut: "⇧⌘[",
          keys: { key: "[", meta: true, shift: true },
          action: () => prevTab(),
        },
        {
          label: "Settings",
          shortcut: "⇧⌘S",
          keys: { key: "s", meta: true, shift: true },
          action: () => uiStore.openSettings(),
        },
      ]);
    }

    async function startApp() {
      if (!appInitialized) {
        initApp();
        appInitialized = true;
      }
      await openStore();
      await restoreSession();
      serverStore.start();
    }

    function globalKeydown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (uiStore.paletteOpen()) {
          e.preventDefault();
          uiStore.closePalette();
          return;
        }
        if (uiStore.settingsOpen()) {
          e.preventDefault();
          uiStore.closeSettings();
          return;
        }
        if (uiStore.searchOpen()) {
          e.preventDefault();
          uiStore.closeSearch();
        }
        return;
      }

      if ((e.metaKey || e.ctrlKey) && e.key === "p") {
        e.preventDefault();
        uiStore.togglePalette();
        return;
      }

      for (const command of commands()) {
        if (command.keys && matchesKey(e, command.keys)) {
          e.preventDefault();
          command.action();
          return;
        }
      }
    }

    createEffect(() => {
      const tab = tabs.activeTab();
      if (!editor) {
        return;
      }
      if (tab) {
        editor.showEditor(tab.path, tab.content, tab.tags);
      } else {
        editor.hideEditor();
      }
    });

    document.addEventListener("keydown", globalKeydown);

    void bootApp({
      checkBrowserSupport,
      showUnsupportedPage: (missing) => {
        showUnsupportedPage(
          document.body,
          missing,
          navigator.userAgent,
          MIN_SUPPORTED_FIREFOX_VERSION,
        );
      },
      getStatus,
      showUnlockScreen,
      startApp,
    });

    onCleanup(() => {
      document.removeEventListener("keydown", globalKeydown);
      serverStore.stop();
    });
  });

  return (
    <ErrorBoundary
      fallback={
        <div style={{ "font-family": "sans-serif", padding: "2rem" }}>
          Something went wrong. Please reload the page.
        </div>
      }
    >
      <Sidebar appEl={props.appEl} />
      <div class="app-main">
        <div
          class={
            uiStore.notification().hidden
              ? "notification hidden"
              : `notification ${uiStore.notification().type}`
          }
          aria-live="assertive"
          aria-atomic="true"
          onClick={() => uiStore.hideNotification()}
        >
          {uiStore.notification().msg}
        </div>
        <div id="tab-bar">
          <TabBarShell />
        </div>
        <div
          class={uiStore.serverStatus() ? "server-status" : "server-status hidden"}
          aria-live="polite"
        >
          {uiStore.serverStatus()}
        </div>
        <div id="editor-area">
          <div
            id="empty-state"
            ref={emptyStateRef}
            style={{ display: editorVisible() ? "none" : "flex" }}
          >
            Press <kbd>Cmd+K</kbd> to search &middot; <kbd>Cmd+P</kbd> for commands
          </div>
          <div style={{ display: editorVisible() ? "" : "none" }}>
            <EditorShell refs={shellRefs} tags={editorTags} isSourceMode={editorSourceMode} />
          </div>
        </div>
      </div>
      <SearchModal openTab={openTab} invalidateNoteCache={invalidateNoteCache} />
      <SettingsModal />
      <div id="input-dialog-overlay" class="hidden" ref={inputDialogOverlayRef}></div>
      <PaletteModal commands={commands} />
    </ErrorBoundary>
  );
}
