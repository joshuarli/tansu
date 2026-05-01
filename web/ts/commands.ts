export type KeyBinding = {
  key: string;
  meta?: boolean;
  shift?: boolean;
  alt?: boolean;
};

export type Command = {
  label: string;
  shortcut: string;
  keys?: KeyBinding;
  action: () => void;
};

export function matchesKey(e: KeyboardEvent, k: Readonly<KeyBinding>): boolean {
  const meta = e.metaKey || e.ctrlKey;
  if (k.meta && !meta) return false;
  if (!k.meta && meta) return false;
  if (k.shift && !e.shiftKey) return false;
  if (!k.shift && e.shiftKey) return false;
  if (k.alt && !e.altKey) return false;
  if (!k.alt && e.altKey) return false;
  return e.key === k.key;
}
