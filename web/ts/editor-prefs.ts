const EDITOR_PREFS_KEY = "editor_prefs";

export type EditorPrefs = {
  undoStackMax: number;
};

const EDITOR_PREFS_DEFAULTS: EditorPrefs = { undoStackMax: 200 };

export function getEditorPrefs(): EditorPrefs {
  try {
    const raw = localStorage.getItem(EDITOR_PREFS_KEY);
    if (!raw) {
      return { ...EDITOR_PREFS_DEFAULTS };
    }
    return { ...EDITOR_PREFS_DEFAULTS, ...(JSON.parse(raw) as Partial<EditorPrefs>) };
  } catch {
    return { ...EDITOR_PREFS_DEFAULTS };
  }
}

export function saveEditorPrefs(prefs: EditorPrefs): void {
  try {
    localStorage.setItem(EDITOR_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* ignore: localStorage may be unavailable */
  }
}
