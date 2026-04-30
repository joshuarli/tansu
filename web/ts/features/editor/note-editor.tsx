import { createEffect, createSignal, onCleanup } from "solid-js";

import { createEditorShellRefs, EditorShell } from "../../editor-shell.tsx";
import { initEditor, type EditorDisplayState, type EditorInstance } from "../../editor.ts";
import type { Tab } from "../../tab-state.ts";

type NoteEditorProps = {
  enabled: () => boolean;
  activeTab: () => Tab | null;
  onEditorChange: (editor: EditorInstance | null) => void;
};

export function NoteEditor(props: Readonly<NoteEditorProps>) {
  let emptyStateRef!: HTMLDivElement;
  let shownTab: { path: string; content: string; tags: readonly string[] } | null = null;

  const shellRefs = createEditorShellRefs();
  const [editor, setEditor] = createSignal<EditorInstance | null>(null);
  const [editorVisible, setEditorVisible] = createSignal(false);
  const [editorTags, setEditorTags] = createSignal<readonly string[]>([]);
  const [editorSourceMode, setEditorSourceMode] = createSignal(false);
  const [displayState, setDisplayState] = createSignal<EditorDisplayState>({ type: "empty" });

  function sameTags(left: readonly string[], right: readonly string[]) {
    return left.length === right.length && left.every((tag, index) => tag === right[index]);
  }

  createEffect(() => {
    if (!props.enabled() || editor()) {
      return;
    }

    const instance = initEditor({
      emptyState: emptyStateRef,
      shellRefs,
      setTags: (tags) => setEditorTags([...tags]),
      setSourceMode: setEditorSourceMode,
      setVisible: setEditorVisible,
      setDisplayState,
    });
    setEditor(instance);
    props.onEditorChange(instance);
  });

  createEffect(() => {
    const instance = editor();
    const tab = props.activeTab();
    if (!instance) {
      return;
    }
    if (tab) {
      const nextShownTab = { path: tab.path, content: tab.content, tags: [...tab.tags] };
      if (
        shownTab &&
        shownTab.path === tab.path &&
        shownTab.content === tab.content &&
        sameTags(shownTab.tags, tab.tags)
      ) {
        return;
      }
      if (shownTab?.path === tab.path && tab.dirty) {
        shownTab = nextShownTab;
        return;
      }
      shownTab = nextShownTab;
      instance.showEditor(tab.path, tab.content, tab.tags);
    } else {
      shownTab = null;
      instance.hideEditor();
    }
  });

  onCleanup(() => {
    shownTab = null;
    editor()?.destroy();
    props.onEditorChange(null);
  });

  return (
    <div id="editor-area" data-editor-state={displayState().type}>
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
  );
}
