import { deleteNote, pinFile, unpinFile } from "./api.ts";
import type { MenuItem } from "./context-menu.tsx";
import { showInputDialog } from "./input-dialog.tsx";
import { renameNoteAndRefresh } from "./note-actions.ts";
import { reportActionError } from "./notify.ts";
import { serverStore } from "./server-store.ts";

type FileActionsOptions = {
  path: string;
  title: string;
  isPinned: boolean;
  onPinChanged?: () => void | Promise<void>;
  onDeleted?: () => void | Promise<void>;
  onClosed?: () => void;
};

function buildRenamedPath(path: string, newName: string): string {
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "";
  return `${dir}${newName}.md`;
}

async function requestRename(path: string, title: string): Promise<void> {
  const newName = await showInputDialog("Rename to...", title);
  if (!newName || newName === title) {
    return;
  }

  await renameNoteAndRefresh(path, buildRenamedPath(path, newName));
}

async function togglePinned(
  path: string,
  isPinned: boolean,
  onPinChanged?: () => void | Promise<void>,
) {
  await (isPinned ? unpinFile(path) : pinFile(path));
  await onPinChanged?.();
  serverStore.notifyPinnedChanged();
}

async function confirmDelete(path: string, title: string, onDeleted?: () => void | Promise<void>) {
  if (!confirm(`Delete ${title}?`)) {
    return;
  }
  await deleteNote(path);
  await onDeleted?.();
  serverStore.notifyFilesChanged();
}

export function buildFileContextMenuItems(opts: FileActionsOptions): MenuItem[] {
  const items: MenuItem[] = [
    {
      label: "Rename...",
      onclick: () => {
        void requestRename(opts.path, opts.title).catch((error) => {
          reportActionError(`Failed to rename ${opts.title}`, error);
        });
      },
    },
    {
      label: opts.isPinned ? "Unpin" : "Pin",
      onclick: () => {
        const action = opts.isPinned
          ? `Failed to unpin ${opts.title}`
          : `Failed to pin ${opts.title}`;
        void togglePinned(opts.path, opts.isPinned, opts.onPinChanged).catch((error) => {
          reportActionError(action, error);
        });
      },
    },
    {
      label: "Delete",
      danger: true,
      onclick: () => {
        void confirmDelete(opts.path, opts.title, opts.onDeleted).catch((error) => {
          reportActionError(`Failed to delete ${opts.title}`, error);
        });
      },
    },
  ];

  if (opts.onClosed) {
    items.push({
      label: "Close",
      onclick: opts.onClosed,
    });
  }

  return items;
}
