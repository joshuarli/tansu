import type { Settings } from "../types.generated.ts";
import type { SettingsFormValue } from "./events.ts";

export const SETTINGS_LIMITS = {
  autosaveDelayMs: { min: 150 },
  undoStackMax: { min: 20 },
  imageWebpQuality: { min: 0.1, max: 1, step: 0.05 },
} as const;

function clampedOr(fallback: number, value: number, min: number, max = Infinity): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function clampedIntegerOr(fallback: number, value: number, min: number): number {
  return Number.isFinite(value) ? Math.max(min, Math.round(value)) : fallback;
}

export function applySettingsForm(current: Settings, form: SettingsFormValue): Settings {
  const { autosaveDelayMs, undoStackMax, imageWebpQuality } = SETTINGS_LIMITS;
  return {
    ...current,
    excludedFolders: form.excludedFoldersText.split(",").map((value) => value.trim()).filter(Boolean),
    autosaveDelayMs: clampedIntegerOr(current.autosaveDelayMs, form.autosaveDelayMs, autosaveDelayMs.min),
    undoStackMax: clampedIntegerOr(current.undoStackMax, form.undoStackMax, undoStackMax.min),
    imageWebpQuality: clampedOr(current.imageWebpQuality, form.imageWebpQuality, imageWebpQuality.min, imageWebpQuality.max),
  };
}
