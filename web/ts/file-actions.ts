import { deleteNote, pinFile, unpinFile } from "./api.ts";
import type { MenuItem } from "./context-menu.ts";
import { emit } from "./events.ts";
import { showInputDialog } from "./input-dialog.ts";

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

  emit("file:rename", { oldPath: path, newPath: buildRenamedPath(path, newName) });
}

async function togglePinned(
  path: string,
  isPinned: boolean,
  onPinChanged?: () => void | Promise<void>,
) {
  await (isPinned ? unpinFile(path) : pinFile(path));
  await onPinChanged?.();
  emit("pinned:changed");
}

async function confirmDelete(path: string, title: string, onDeleted?: () => void | Promise<void>) {
  if (!confirm(`Delete ${title}?`)) {
    return;
  }
  await deleteNote(path);
  await onDeleted?.();
  emit("files:changed", {});
}

export function buildFileContextMenuItems(opts: FileActionsOptions): MenuItem[] {
  const items: MenuItem[] = [
    {
      label: "Rename...",
      onclick: () => {
        void requestRename(opts.path, opts.title).catch(() => void 0);
      },
    },
    {
      label: opts.isPinned ? "Unpin" : "Pin",
      onclick: () => {
        void togglePinned(opts.path, opts.isPinned, opts.onPinChanged).catch(() => void 0);
      },
    },
    {
      label: "Delete",
      danger: true,
      onclick: () => {
        void confirmDelete(opts.path, opts.title, opts.onDeleted).catch(() => void 0);
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
