import { shiftIndent } from "@joshuarli98/md-wysiwyg";

import { showContextMenu } from "./context-menu.tsx";
import type { EditorAdapter } from "./editor-adapter.ts";
import type { EditorShellRefs } from "./editor-shell.tsx";
import { initFormatToolbar, populateFormatButtons } from "./format-toolbar.ts";
import { toggleRevisions, isRevisionsOpen } from "./revisions.tsx";
import { hideTagAutocomplete } from "./tag-autocomplete.ts";

type ShellWiringOptions = {
  shellRefs: EditorShellRefs;
  getHandle: () => EditorAdapter | null;
  getCurrentPath: () => string | null;
  getCurrentContent: () => string;
  onMutation: () => void;
  onToggleSourceMode: () => void;
  onRemoveTag: (tag: string) => void;
};

export function wireEditorShell(opts: Readonly<ShellWiringOptions>): {
  attachToHandle(handle: EditorAdapter): void;
  dispose(): void;
} {
  let formatToolbarCleanup: (() => void) | null = null;

  opts.shellRefs.sourceBtnEl.onclick = () => {
    opts.onToggleSourceMode();
  };

  opts.shellRefs.menuBtnEl.onclick = () => {
    const rect = opts.shellRefs.menuBtnEl.getBoundingClientRect();
    showContextMenu(
      [
        {
          label: "Revisions",
          onclick: () => {
            const currentPath = opts.getCurrentPath();
            const handle = opts.getHandle();
            if (!currentPath || !handle) {
              return;
            }
            toggleRevisions({
              path: currentPath,
              host: opts.shellRefs.revisionsEl,
              getCurrentContent: opts.getCurrentContent,
              onHide: () => {
                opts.shellRefs.revisionsEl.style.display = "none";
                if (handle.isSourceMode) {
                  handle.sourceEl.style.display = "";
                } else {
                  handle.contentEl.style.display = "";
                }
              },
            });
            if (isRevisionsOpen()) {
              handle.contentEl.style.display = "none";
              handle.sourceEl.style.display = "none";
              opts.shellRefs.revisionsEl.style.display = "";
            }
          },
        },
      ],
      rect.left,
      rect.bottom + 4,
    );
  };

  opts.shellRefs.tagRowEl.onclick = (e) => {
    const target = e.target as HTMLElement | null;
    const removeBtn = target?.closest<HTMLButtonElement>(".tag-pill-remove");
    const tag = removeBtn?.dataset["tagRemove"];
    if (tag) {
      e.preventDefault();
      e.stopPropagation();
      hideTagAutocomplete();
      opts.onRemoveTag(tag);
      return;
    }
    opts.shellRefs.getTagInputEl()?.focus();
  };

  function attachToHandle(handle: EditorAdapter) {
    formatToolbarCleanup?.();
    formatToolbarCleanup = initFormatToolbar({
      contentEl: handle.contentEl,
      applyIndent: (dedent) =>
        handle.applyFormat((md, selStart, selEnd) => shiftIndent(md, selStart, selEnd, dedent)),
      applySourceFormat: (transform) => handle.applyFormat(transform),
      onMutation: opts.onMutation,
    });

    opts.shellRefs.fmtGroupEl.textContent = "";
    populateFormatButtons(opts.shellRefs.fmtGroupEl, {
      applyIndent: (dedent) =>
        handle.applyFormat((md, selStart, selEnd) => shiftIndent(md, selStart, selEnd, dedent)),
      applySourceFormat: (transform) => handle.applyFormat(transform),
      afterInline: opts.onMutation,
      afterBlock: opts.onMutation,
    });
  }

  return {
    attachToHandle,
    dispose() {
      formatToolbarCleanup?.();
      formatToolbarCleanup = null;
      opts.shellRefs.sourceBtnEl.onclick = null;
      opts.shellRefs.menuBtnEl.onclick = null;
      opts.shellRefs.tagRowEl.onclick = null;
    },
  };
}
