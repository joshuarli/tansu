import type { Settings } from "./api.ts";
import { getActiveVaultIndex } from "./vault-session.ts";

const VAULT_SETTINGS_KEY_PREFIX = "vault_settings";
const APP_SETTINGS_KEY = "app_settings";

export type ServerSectionId = "search-weights" | "search-options" | "excluded-folders";
export type AppSectionId = "images";
export type VaultSectionId =
  | "editor"
  | "search-ui"
  | "search-cli"
  | "autocomplete"
  | "tag-autocomplete"
  | "autosave"
  | "format-toolbar"
  | "session"
  | "notifications";
export type SectionId = ServerSectionId | VaultSectionId | AppSectionId;

export type SelectOption = {
  value: string | number;
  label: string;
};

export type StringFieldDefinition<Model, K extends keyof Model> = {
  section: SectionId;
  label: string;
  kind: "range" | "select" | "number" | "text";
  parse: (value: string) => Model[K];
  format?: (value: Model[K]) => string;
  hint?: string;
  placeholder?: string;
  min?: number;
  max?: number;
  step?: number;
  options?: readonly SelectOption[];
  saveOnEnter?: boolean;
};

export type CheckboxFieldDefinition<Model, K extends keyof Model> = {
  section: SectionId;
  label: string;
  kind: "checkbox";
  parse: (checked: boolean) => Model[K];
};

export type FieldDefinition<Model, K extends keyof Model> =
  | StringFieldDefinition<Model, K>
  | CheckboxFieldDefinition<Model, K>;

export type FieldRegistry<Model extends Record<string, unknown>> = {
  [K in keyof Model]: FieldDefinition<Model, K>;
};

export type FieldEntry<Model extends Record<string, unknown>> = {
  [K in keyof Model]: readonly [K, FieldDefinition<Model, K>];
}[keyof Model];

export type VaultSettings = {
  undoStackMax: number;
  searchMinQueryLength: number;
  searchScorePrecision: number;
  searchCliDefaultPort: string;
  autocompleteMaxResults: number;
  autocompleteOffsetPx: number;
  tagAutocompleteMaxResults: number;
  tagAutocompleteOffsetPx: number;
  tagAutocompleteMinWidthPx: number;
  autosaveDelayMs: number;
  autosaveRetryDelayMs: number;
  formatToolbarGapPx: number;
  formatToolbarEdgePaddingPx: number;
  formatToolbarIconSizePx: number;
  formatToolbarStrokeWidth: number;
  formatToolbarHeadingLevels: number[];
  sessionMaxClosedTabs: number;
  notificationAutoDismissMs: number;
};

export type AppSettings = {
  imageWebpQuality: number;
  imageResizeMinWidthPx: number;
  imageResizeWheelScale: number;
};

export type EditorPrefs = VaultSettings;
export type EditorRuntimeSettings = Pick<VaultSettings, "undoStackMax"> &
  Pick<AppSettings, "imageWebpQuality">;

export const SERVER_SETTINGS_SECTION_ORDER = [
  { id: "search-weights", title: "Search weights" },
  { id: "search-options", title: "Search options" },
  { id: "excluded-folders", title: "Excluded folders" },
] as const satisfies readonly { id: ServerSectionId; title: string }[];

export const VAULT_SETTINGS_SECTION_ORDER = [
  { id: "editor", title: "Editor" },
  { id: "search-ui", title: "Search UI" },
  { id: "search-cli", title: "Search CLI" },
  { id: "autocomplete", title: "Wiki-link autocomplete" },
  { id: "tag-autocomplete", title: "Tag autocomplete" },
  { id: "autosave", title: "Autosave" },
  { id: "format-toolbar", title: "Format toolbar" },
  { id: "session", title: "Session" },
  { id: "notifications", title: "Notifications" },
] as const satisfies readonly { id: VaultSectionId; title: string }[];

export const APP_SETTINGS_SECTION_ORDER = [
  { id: "images", title: "Images" },
] as const satisfies readonly { id: AppSectionId; title: string }[];

export const SERVER_SETTINGS_DEFAULTS: Settings = {
  weight_title: 10,
  weight_headings: 5,
  weight_tags: 25,
  weight_content: 1,
  fuzzy_distance: 1,
  recency_boost: 2,
  result_limit: 20,
  show_score_breakdown: true,
  excluded_folders: [],
};

export const VAULT_SETTINGS_DEFAULTS: VaultSettings = {
  undoStackMax: 200,
  searchMinQueryLength: 2,
  searchScorePrecision: 3,
  searchCliDefaultPort: "3000",
  autocompleteMaxResults: 10,
  autocompleteOffsetPx: 4,
  tagAutocompleteMaxResults: 10,
  tagAutocompleteOffsetPx: 4,
  tagAutocompleteMinWidthPx: 160,
  autosaveDelayMs: 1_500,
  autosaveRetryDelayMs: 500,
  formatToolbarGapPx: 8,
  formatToolbarEdgePaddingPx: 8,
  formatToolbarIconSizePx: 13,
  formatToolbarStrokeWidth: 1.75,
  formatToolbarHeadingLevels: [1, 2, 3, 4],
  sessionMaxClosedTabs: 20,
  notificationAutoDismissMs: 5_000,
};

export const APP_SETTINGS_DEFAULTS: AppSettings = {
  imageWebpQuality: 0.85,
  imageResizeMinWidthPx: 50,
  imageResizeWheelScale: 1.5,
};

function getVaultSettingsStorageKey(): string {
  if (typeof sessionStorage === "undefined") {
    return `${VAULT_SETTINGS_KEY_PREFIX}:0`;
  }
  try {
    return `${VAULT_SETTINGS_KEY_PREFIX}:${getActiveVaultIndex()}`;
  } catch {
    return `${VAULT_SETTINGS_KEY_PREFIX}:0`;
  }
}

export function defaultSettings(): Settings {
  return {
    ...SERVER_SETTINGS_DEFAULTS,
    excluded_folders: [...SERVER_SETTINGS_DEFAULTS.excluded_folders],
  };
}

export function defaultVaultSettings(): VaultSettings {
  return {
    ...VAULT_SETTINGS_DEFAULTS,
    formatToolbarHeadingLevels: [...VAULT_SETTINGS_DEFAULTS.formatToolbarHeadingLevels],
  };
}

export function defaultAppSettings(): AppSettings {
  return { ...APP_SETTINGS_DEFAULTS };
}

export function normalizeExcludedFolders(values: readonly string[]): string[] {
  return values.map((value) => value.trim()).filter((value) => value.length > 0);
}

function normalizeNumberList(values: readonly number[]): number[] {
  return values.filter((value) => Number.isFinite(value) && value > 0);
}

function parseNumberList(value: string): number[] {
  return normalizeNumberList(
    value
      .split(",")
      .map((part) => Number.parseInt(part.trim(), 10))
      .filter((part) => !Number.isNaN(part)),
  );
}

function formatNumberList(values: readonly number[]): string {
  return values.join(", ");
}

export function recencyLabel(value: number): string {
  if (value === 0) {
    return "Disabled";
  }
  if (value === 1) {
    return "24 hours";
  }
  if (value === 2) {
    return "7 days";
  }
  return "30 days";
}

export const SERVER_SETTING_FIELDS = {
  weight_title: {
    section: "search-weights",
    label: "Title",
    kind: "range",
    min: 0,
    max: 20,
    step: 0.5,
    parse: (value) => Number.parseFloat(value),
  },
  weight_headings: {
    section: "search-weights",
    label: "Headings",
    kind: "range",
    min: 0,
    max: 20,
    step: 0.5,
    parse: (value) => Number.parseFloat(value),
  },
  weight_tags: {
    section: "search-weights",
    label: "Tags",
    kind: "range",
    min: 0,
    max: 20,
    step: 0.5,
    parse: (value) => Number.parseFloat(value),
  },
  weight_content: {
    section: "search-weights",
    label: "Content",
    kind: "range",
    min: 0,
    max: 20,
    step: 0.5,
    parse: (value) => Number.parseFloat(value),
  },
  fuzzy_distance: {
    section: "search-options",
    label: "Fuzzy distance",
    kind: "select",
    options: [0, 1, 2].map((value) => ({
      value,
      label: value === 0 ? "0 (exact only)" : String(value),
    })),
    parse: (value) => Number.parseInt(value, 10),
  },
  recency_boost: {
    section: "search-options",
    label: "Recency boost",
    kind: "select",
    options: [0, 1, 2, 3].map((value) => ({
      value,
      label: recencyLabel(value),
    })),
    parse: (value) => Number.parseInt(value, 10),
  },
  result_limit: {
    section: "search-options",
    label: "Result limit",
    kind: "number",
    min: 5,
    max: 100,
    step: 5,
    parse: (value) => Number.parseInt(value, 10),
  },
  show_score_breakdown: {
    section: "search-options",
    label: "Show score breakdown",
    kind: "checkbox",
    parse: (checked) => checked,
  },
  excluded_folders: {
    section: "excluded-folders",
    label: "Excluded folders",
    kind: "text",
    hint: "Comma-separated folder names to exclude from indexing. Changes trigger a reindex.",
    placeholder: "archive, drafts",
    saveOnEnter: true,
    parse: (value) => normalizeExcludedFolders(value.split(",")),
    format: (value) => value.join(", "),
  },
} satisfies FieldRegistry<Settings>;

export const VAULT_SETTING_FIELDS = {
  undoStackMax: {
    section: "editor",
    label: "Undo history",
    kind: "number",
    min: 50,
    max: 1_000,
    step: 50,
    parse: (value) => Number.parseInt(value, 10),
  },
  searchMinQueryLength: {
    section: "search-ui",
    label: "Minimum query length",
    kind: "number",
    min: 1,
    max: 20,
    step: 1,
    parse: (value) => Number.parseInt(value, 10),
  },
  searchScorePrecision: {
    section: "search-ui",
    label: "Score precision",
    kind: "number",
    min: 1,
    max: 10,
    step: 1,
    parse: (value) => Number.parseInt(value, 10),
  },
  searchCliDefaultPort: {
    section: "search-cli",
    label: "Default port",
    kind: "text",
    parse: (value) => value.trim(),
  },
  autocompleteMaxResults: {
    section: "autocomplete",
    label: "Max results",
    kind: "number",
    min: 1,
    max: 100,
    step: 1,
    parse: (value) => Number.parseInt(value, 10),
  },
  autocompleteOffsetPx: {
    section: "autocomplete",
    label: "Vertical offset",
    kind: "number",
    min: 0,
    max: 100,
    step: 1,
    parse: (value) => Number.parseInt(value, 10),
  },
  tagAutocompleteMaxResults: {
    section: "tag-autocomplete",
    label: "Max results",
    kind: "number",
    min: 1,
    max: 100,
    step: 1,
    parse: (value) => Number.parseInt(value, 10),
  },
  tagAutocompleteOffsetPx: {
    section: "tag-autocomplete",
    label: "Vertical offset",
    kind: "number",
    min: 0,
    max: 100,
    step: 1,
    parse: (value) => Number.parseInt(value, 10),
  },
  tagAutocompleteMinWidthPx: {
    section: "tag-autocomplete",
    label: "Minimum width",
    kind: "number",
    min: 0,
    max: 1_000,
    step: 1,
    parse: (value) => Number.parseInt(value, 10),
  },
  autosaveDelayMs: {
    section: "autosave",
    label: "Autosave delay (ms)",
    kind: "number",
    min: 0,
    max: 60_000,
    step: 100,
    parse: (value) => Number.parseInt(value, 10),
  },
  autosaveRetryDelayMs: {
    section: "autosave",
    label: "Retry delay (ms)",
    kind: "number",
    min: 0,
    max: 60_000,
    step: 100,
    parse: (value) => Number.parseInt(value, 10),
  },
  formatToolbarGapPx: {
    section: "format-toolbar",
    label: "Gap",
    kind: "number",
    min: 0,
    max: 200,
    step: 1,
    parse: (value) => Number.parseInt(value, 10),
  },
  formatToolbarEdgePaddingPx: {
    section: "format-toolbar",
    label: "Edge padding",
    kind: "number",
    min: 0,
    max: 200,
    step: 1,
    parse: (value) => Number.parseInt(value, 10),
  },
  formatToolbarIconSizePx: {
    section: "format-toolbar",
    label: "Icon size",
    kind: "number",
    min: 1,
    max: 200,
    step: 1,
    parse: (value) => Number.parseInt(value, 10),
  },
  formatToolbarStrokeWidth: {
    section: "format-toolbar",
    label: "Stroke width",
    kind: "number",
    min: 0.1,
    max: 10,
    step: 0.05,
    parse: (value) => Number.parseFloat(value),
  },
  formatToolbarHeadingLevels: {
    section: "format-toolbar",
    label: "Heading levels",
    kind: "text",
    hint: "Comma-separated heading levels shown in the toolbar.",
    placeholder: "1, 2, 3, 4",
    parse: parseNumberList,
    format: formatNumberList,
  },
  sessionMaxClosedTabs: {
    section: "session",
    label: "Closed tab history",
    kind: "number",
    min: 0,
    max: 1_000,
    step: 1,
    parse: (value) => Number.parseInt(value, 10),
  },
  notificationAutoDismissMs: {
    section: "notifications",
    label: "Auto-dismiss delay (ms)",
    kind: "number",
    min: 0,
    max: 60_000,
    step: 100,
    parse: (value) => Number.parseInt(value, 10),
  },
} satisfies FieldRegistry<VaultSettings>;

export const EDITOR_PREF_FIELDS = VAULT_SETTING_FIELDS;

export const APP_SETTING_FIELDS = {
  imageWebpQuality: {
    section: "images",
    label: "WebP quality",
    kind: "range",
    min: 0,
    max: 1,
    step: 0.01,
    parse: (value) => Number.parseFloat(value),
  },
  imageResizeMinWidthPx: {
    section: "images",
    label: "Minimum resize width",
    kind: "number",
    min: 1,
    max: 5_000,
    step: 1,
    parse: (value) => Number.parseInt(value, 10),
  },
  imageResizeWheelScale: {
    section: "images",
    label: "Wheel resize scale",
    kind: "number",
    min: 0.1,
    max: 10,
    step: 0.1,
    parse: (value) => Number.parseFloat(value),
  },
} satisfies FieldRegistry<AppSettings>;

export function getFieldEntries<Model extends Record<string, unknown>>(
  registry: FieldRegistry<Model>,
): FieldEntry<Model>[] {
  return Object.entries(registry) as FieldEntry<Model>[];
}

export function parseStringField<Model extends Record<string, unknown>, K extends keyof Model>(
  registry: FieldRegistry<Model>,
  key: K,
  rawValue: string,
): Model[K] {
  const field = registry[key];
  if (field.kind === "checkbox") {
    throw new Error(`Expected string field for ${String(key)}`);
  }
  return field.parse(rawValue);
}

export function parseCheckboxField<Model extends Record<string, unknown>, K extends keyof Model>(
  registry: FieldRegistry<Model>,
  key: K,
  checked: boolean,
): Model[K] {
  const field = registry[key];
  if (field.kind !== "checkbox") {
    throw new Error(`Expected checkbox field for ${String(key)}`);
  }
  return field.parse(checked);
}

export function updateObjectField<Model extends Record<string, unknown>, K extends keyof Model>(
  current: Model,
  key: K,
  value: Model[K],
): Model {
  return { ...current, [key]: value };
}

export function getVaultSettings(): VaultSettings {
  if (typeof localStorage === "undefined") {
    return defaultVaultSettings();
  }
  try {
    const raw = localStorage.getItem(getVaultSettingsStorageKey());
    if (!raw) {
      return defaultVaultSettings();
    }
    const parsed = JSON.parse(raw) as Partial<VaultSettings>;
    return {
      ...defaultVaultSettings(),
      ...parsed,
      ...(parsed.formatToolbarHeadingLevels !== undefined
        ? { formatToolbarHeadingLevels: normalizeNumberList(parsed.formatToolbarHeadingLevels) }
        : {}),
    };
  } catch {
    return defaultVaultSettings();
  }
}

export function saveVaultSettings(settings: VaultSettings): void {
  if (typeof localStorage === "undefined") {
    return;
  }
  try {
    localStorage.setItem(
      getVaultSettingsStorageKey(),
      JSON.stringify({
        ...settings,
        formatToolbarHeadingLevels: normalizeNumberList(settings.formatToolbarHeadingLevels),
      }),
    );
  } catch {
    /* ignore: localStorage may be unavailable */
  }
}

export function getAppSettings(): AppSettings {
  if (typeof localStorage === "undefined") {
    return defaultAppSettings();
  }
  try {
    const raw = localStorage.getItem(APP_SETTINGS_KEY);
    if (!raw) {
      return defaultAppSettings();
    }
    return {
      ...defaultAppSettings(),
      ...(JSON.parse(raw) as Partial<AppSettings>),
    };
  } catch {
    return defaultAppSettings();
  }
}

export function saveAppSettings(settings: AppSettings): void {
  if (typeof localStorage === "undefined") {
    return;
  }
  try {
    localStorage.setItem(APP_SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* ignore: localStorage may be unavailable */
  }
}

export function getEditorRuntimeSettings(): EditorRuntimeSettings {
  const vault = getVaultSettings();
  const app = getAppSettings();
  return {
    undoStackMax: vault.undoStackMax,
    imageWebpQuality: app.imageWebpQuality,
  };
}

export function getEditorPrefs(): EditorPrefs {
  return getVaultSettings();
}

export function saveEditorPrefs(prefs: EditorPrefs): void {
  saveVaultSettings(prefs);
}
