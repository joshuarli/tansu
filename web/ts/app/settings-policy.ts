import type { Settings } from "../types.generated.ts";
import type { SettingsFormValue } from "./events.ts";

export const SETTINGS_LIMITS = {
  autosaveDelayMs: { min: 150, max: 3_600_000 },
  undoStackMax: { min: 20, max: 10_000 },
  imageWebpQuality: { min: 0.1, max: 1, step: 0.05 },
  searchWeight: { min: 0, max: 1000 },
} as const;

const SINGLE_FOLDER_NAME_MESSAGE = "Excluded folders must be single folder names separated by commas, without /, \\, or . and .. entries.";

function clampedOr(fallback: number, value: number, { min, max }: { min: number; max: number }): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function clampedIntegerOr(fallback: number, value: number, limit: { min: number; max: number }): number {
  return Number.isFinite(value) ? clampedOr(fallback, Math.round(value), limit) : fallback;
}

function splitExcludedFolders(text: string): string[] {
  return text.split(",").map((value) => value.trim()).filter(Boolean);
}

function isSingleFolderName(entry: string): boolean {
  return entry !== "." && entry !== ".." && !/[/\\\0]/.test(entry);
}

export function excludedFoldersProblem(text: string): string | null {
  return splitExcludedFolders(text).every(isSingleFolderName) ? null : SINGLE_FOLDER_NAME_MESSAGE;
}

export function normalizeSettings(settings: Settings): Settings {
  const { autosaveDelayMs, undoStackMax, imageWebpQuality, searchWeight } = SETTINGS_LIMITS;
  return {
    ...settings,
    autosaveDelayMs: clampedIntegerOr(autosaveDelayMs.min, settings.autosaveDelayMs, autosaveDelayMs),
    undoStackMax: clampedIntegerOr(undoStackMax.min, settings.undoStackMax, undoStackMax),
    imageWebpQuality: clampedOr(imageWebpQuality.max, settings.imageWebpQuality, imageWebpQuality),
    searchTitleWeight: clampedOr(searchWeight.min, settings.searchTitleWeight, searchWeight),
    searchHeadingWeight: clampedOr(searchWeight.min, settings.searchHeadingWeight, searchWeight),
    searchTagWeight: clampedOr(searchWeight.min, settings.searchTagWeight, searchWeight),
    searchContentWeight: clampedOr(searchWeight.min, settings.searchContentWeight, searchWeight),
    recencyBoost: clampedOr(searchWeight.min, settings.recencyBoost, searchWeight),
  };
}

export function applySettingsForm(current: Settings, form: SettingsFormValue): Settings {
  const problem = excludedFoldersProblem(form.excludedFoldersText);
  if (problem !== null) throw new Error(problem);
  const { autosaveDelayMs, undoStackMax, imageWebpQuality } = SETTINGS_LIMITS;
  const base = normalizeSettings(current);
  return {
    ...base,
    excludedFolders: splitExcludedFolders(form.excludedFoldersText),
    autosaveDelayMs: clampedIntegerOr(base.autosaveDelayMs, form.autosaveDelayMs, autosaveDelayMs),
    undoStackMax: clampedIntegerOr(base.undoStackMax, form.undoStackMax, undoStackMax),
    imageWebpQuality: clampedOr(base.imageWebpQuality, form.imageWebpQuality, imageWebpQuality),
  };
}
