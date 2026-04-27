import { For, createSignal } from "solid-js";
import { render } from "solid-js/web";

const SOURCE_ICON =
  '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polyline points="5,4 1,8 5,12"/><polyline points="11,4 15,8 11,12"/><line x1="9.5" y1="2" x2="6.5" y2="14"/></svg>';
const MENU_ICON =
  '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><rect x="1" y="3" width="14" height="2" rx="1"/><rect x="1" y="7" width="14" height="2" rx="1"/><rect x="1" y="11" width="14" height="2" rx="1"/></svg>';

export type EditorShellRefs = {
  containerEl: HTMLDivElement;
  toolbarEl: HTMLDivElement;
  fmtGroupEl: HTMLDivElement;
  sourceBtnEl: HTMLButtonElement;
  menuBtnEl: HTMLButtonElement;
  tagRowEl: HTMLDivElement;
  contentEl: HTMLDivElement;
  sourceEl: HTMLTextAreaElement;
  revisionsEl: HTMLDivElement;
  backlinksEl: HTMLDivElement;
  getTagInputEl(): HTMLInputElement | null;
};

type EditorShellOptions = {
  root: HTMLElement;
  tags: readonly string[];
  isSourceMode: boolean;
};

export type EditorShellController = {
  dispose(): void;
  refs: EditorShellRefs;
  setTags(tags: readonly string[]): void;
  setSourceMode(value: boolean): void;
};

function EditorShellView(
  props: Readonly<{
    tags: () => readonly string[];
    isSourceMode: () => boolean;
    options: EditorShellOptions;
    refs: EditorShellRefs;
  }>,
) {
  return (
    <>
      <div class="editor-toolbar" ref={props.refs.toolbarEl}>
        <div
          class="editor-toolbar-fmt-group"
          ref={props.refs.fmtGroupEl}
          style={{ display: props.isSourceMode() ? "none" : "flex" }}
        />
        <div style={{ flex: "1" }} />
        <button
          ref={props.refs.sourceBtnEl}
          type="button"
          class={`editor-toolbar-btn editor-toolbar-btn--source${props.isSourceMode() ? " active" : ""}`}
          title="Toggle source mode"
          aria-label="Toggle source mode"
          innerHTML={SOURCE_ICON}
        />
        <button
          ref={props.refs.menuBtnEl}
          type="button"
          class="editor-toolbar-btn"
          title="More"
          aria-label="More options"
          innerHTML={MENU_ICON}
        />
      </div>
      <div class="editor-container" ref={props.refs.containerEl}>
        <div class="editor-tags" ref={props.refs.tagRowEl}>
          <For each={props.tags()}>
            {(tag) => (
              <span class="tag-pill tag-pill--editor">
                <span>{`#${tag}`}</span>
                <button
                  type="button"
                  class="tag-pill-remove"
                  data-tag-remove={tag}
                  aria-label={`Remove tag #${tag}`}
                >
                  ×
                </button>
              </span>
            )}
          </For>
          <input
            ref={(el) => {
              props.refs.getTagInputEl = () => el;
            }}
            type="text"
            class="editor-tags-input"
            placeholder={props.tags().length === 0 ? "Add tags" : "Add tag"}
            aria-label="Add tag"
            autocomplete="off"
            autocapitalize="off"
            spellcheck={false}
          />
        </div>
        <div
          ref={(el) => {
            props.refs.contentEl = el;
            el.contentEditable = "true";
          }}
          class="editor-content"
          spellcheck={true}
          style={{ display: props.isSourceMode() ? "none" : "" }}
        />
        <textarea
          ref={props.refs.sourceEl}
          class="editor-source"
          style={{ display: props.isSourceMode() ? "" : "none" }}
        />
        <div ref={props.refs.revisionsEl} class="revisions-container" style={{ display: "none" }} />
      </div>
      <div ref={props.refs.backlinksEl} class="backlinks" style={{ display: "none" }} />
    </>
  );
}

export function mountEditorShell(options: EditorShellOptions): EditorShellController {
  const [tags, setTags] = createSignal<readonly string[]>([...options.tags]);
  const [isSourceMode, setIsSourceMode] = createSignal(options.isSourceMode);

  const refs = {
    containerEl: null!,
    toolbarEl: null!,
    fmtGroupEl: null!,
    sourceBtnEl: null!,
    menuBtnEl: null!,
    tagRowEl: null!,
    contentEl: null!,
    sourceEl: null!,
    revisionsEl: null!,
    backlinksEl: null!,
    getTagInputEl: () => null,
  } satisfies EditorShellRefs;

  const dispose = render(
    () => <EditorShellView tags={tags} isSourceMode={isSourceMode} options={options} refs={refs} />,
    options.root,
  );

  return {
    dispose,
    refs,
    setTags(nextTags) {
      setTags([...nextTags]);
    },
    setSourceMode(value) {
      setIsSourceMode(value);
    },
  };
}
