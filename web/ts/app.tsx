import { ErrorBoundary, createEffect, createSignal, onCleanup, onMount } from "solid-js";

import { createAppBootController } from "./app-boot.ts";
import { createAppCommands, handleGlobalAppKeydown } from "./app-commands.ts";
import { configureServerRuntime, registerWikiLinkNavigation } from "./app-runtime.ts";
import { createEditorShellRefs, EditorShell } from "./editor-shell.tsx";
import { initEditor, invalidateNoteCache, type EditorInstance } from "./editor.ts";
import { Sidebar } from "./filenav.tsx";
import { InputDialogHost } from "./input-dialog.tsx";
import { PaletteModal, type Command } from "./palette.tsx";
import { SearchModal } from "./search.tsx";
import { serverStore } from "./server-store.ts";
import { SettingsModal } from "./settings.tsx";
import { openTab, useTabs } from "./tab-state.ts";
import { TabBarShell } from "./tabs.tsx";
import { uiStore } from "./ui-store.ts";

type AppProps = {
  appEl: HTMLElement;
};

export function App(props: Readonly<AppProps>) {
  let emptyStateRef!: HTMLDivElement;
  let editor: EditorInstance | null = null;

  const shellRefs = createEditorShellRefs();
  const [editorVisible, setEditorVisible] = createSignal(false);
  const [editorTags, setEditorTags] = createSignal<readonly string[]>([]);
  const [editorSourceMode, setEditorSourceMode] = createSignal(false);
  const [commands, setCommands] = createSignal<readonly Command[]>([]);
  const tabs = useTabs();

  onMount(() => {
    let boot: ReturnType<typeof createAppBootController>;

    function initApp() {
      editor = initEditor({
        emptyState: emptyStateRef,
        shellRefs,
        setTags: (tags) => setEditorTags([...tags]),
        setSourceMode: setEditorSourceMode,
        setVisible: setEditorVisible,
      });

      registerWikiLinkNavigation();
      configureServerRuntime({
        getEditor: () => editor,
        showUnlockScreen: () => boot.showUnlockScreen(),
      });

      setCommands(createAppCommands({ getEditor: () => editor }));
    }

    boot = createAppBootController({
      appEl: props.appEl,
      initApp,
    });

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

    const globalKeydown = (e: KeyboardEvent) => {
      handleGlobalAppKeydown(e, commands);
    };
    document.addEventListener("keydown", globalKeydown);

    void boot.boot();

    onCleanup(() => {
      document.removeEventListener("keydown", globalKeydown);
      editor?.destroy();
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
      <SettingsModal
        onApplyEditorPrefs={(prefs) => {
          editor?.applyPrefs(prefs);
        }}
      />
      <InputDialogHost />
      <PaletteModal commands={commands} />
    </ErrorBoundary>
  );
}
