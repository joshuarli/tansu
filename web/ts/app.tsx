import { ErrorBoundary, createSignal, onCleanup, onMount } from "solid-js";

import { AlertDialogHost } from "./alert-dialog.tsx";
import { createAppBootController } from "./app-boot.ts";
import { createAppCommands, handleGlobalAppKeydown } from "./app-commands.ts";
import { configureServerRuntime, registerWikiLinkNavigation } from "./app-runtime.ts";
import { invalidateNoteCache, type EditorInstance } from "./editor.ts";
import { NoteEditor } from "./features/editor/note-editor.tsx";
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
  let editor: EditorInstance | null = null;

  const [editorEnabled, setEditorEnabled] = createSignal(false);
  const [commands, setCommands] = createSignal<readonly Command[]>([]);
  const tabs = useTabs();

  onMount(() => {
    let boot: ReturnType<typeof createAppBootController>;
    let disposeWikiLinkNavigation: (() => void) | null = null;

    function initApp() {
      disposeWikiLinkNavigation = registerWikiLinkNavigation();
      configureServerRuntime({
        getEditor: () => editor,
        showUnlockScreen: () => boot.showUnlockScreen(),
      });

      setCommands(createAppCommands({ getEditor: () => editor }));
      setEditorEnabled(true);
    }

    boot = createAppBootController({
      appEl: props.appEl,
      initApp,
    });

    const globalKeydown = (e: KeyboardEvent) => {
      handleGlobalAppKeydown(e, commands);
    };
    document.addEventListener("keydown", globalKeydown);

    void boot.boot();

    onCleanup(() => {
      disposeWikiLinkNavigation?.();
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
        <NoteEditor
          enabled={editorEnabled}
          activeTab={tabs.activeTab}
          onEditorChange={(nextEditor) => {
            editor = nextEditor;
          }}
        />
      </div>
      <SearchModal openTab={openTab} invalidateNoteCache={invalidateNoteCache} />
      <SettingsModal
        onApplyEditorPrefs={(prefs) => {
          editor?.applyPrefs(prefs);
        }}
      />
      <AlertDialogHost />
      <InputDialogHost />
      <PaletteModal commands={commands} />
    </ErrorBoundary>
  );
}
