import type { Command } from "./commands.ts";

type AppCommandRegistryOptions = {
  getActiveSearchPath: () => string | undefined;
  openSearch: (scopePath?: string) => void;
  openNewNote: () => Promise<void>;
  openHtmlImport: () => void;
  reopenClosedTab: () => Promise<void>;
  saveCurrentNote: () => Promise<void> | undefined;
  closeActiveTab: () => void;
  nextTab: () => void;
  prevTab: () => void;
  openAppSettings: () => void;
  openServerSettings: () => void;
  openVaultSettings: () => void;
};

export function createAppCommandRegistry(
  opts: Readonly<AppCommandRegistryOptions>,
): readonly Command[] {
  return [
    {
      label: "Search notes",
      shortcut: "⌘K",
      keys: { key: "k", meta: true },
      action: () => opts.openSearch(),
    },
    {
      label: "Search in current note",
      shortcut: "⌘F",
      keys: { key: "f", meta: true },
      action: () => opts.openSearch(opts.getActiveSearchPath()),
    },
    {
      label: "Global search",
      shortcut: "⇧⌘F",
      keys: { key: "f", meta: true, shift: true },
      action: () => opts.openSearch(),
    },
    {
      label: "New note",
      shortcut: "⌘N",
      keys: { key: "n", meta: true },
      action: () => {
        void opts.openNewNote();
      },
    },
    {
      label: "Import HTML file",
      shortcut: "⌘I",
      keys: { key: "i", meta: true },
      action: () => opts.openHtmlImport(),
    },
    {
      label: "Reopen closed tab",
      shortcut: "⇧⌘T",
      keys: { key: "t", meta: true, shift: true },
      action: () => {
        void opts.reopenClosedTab();
      },
    },
    {
      label: "Save",
      shortcut: "⌘S",
      keys: { key: "s", meta: true },
      action: () => {
        void opts.saveCurrentNote();
      },
    },
    {
      label: "Close tab",
      shortcut: "⌘W",
      keys: { key: "w", meta: true },
      action: () => opts.closeActiveTab(),
    },
    {
      label: "Next tab",
      shortcut: "⇧⌘]",
      keys: { key: "]", meta: true, shift: true },
      action: () => opts.nextTab(),
    },
    {
      label: "Previous tab",
      shortcut: "⇧⌘[",
      keys: { key: "[", meta: true, shift: true },
      action: () => opts.prevTab(),
    },
    {
      label: "App settings",
      shortcut: "⌘,",
      keys: { key: ",", meta: true },
      action: () => opts.openAppSettings(),
    },
    {
      label: "Vault settings",
      shortcut: "⇧⌘,",
      keys: { key: ",", meta: true, shift: true },
      action: () => opts.openVaultSettings(),
    },
    {
      label: "Server settings",
      shortcut: "⌥⌘,",
      keys: { key: ",", meta: true, alt: true },
      action: () => opts.openServerSettings(),
    },
  ];
}
