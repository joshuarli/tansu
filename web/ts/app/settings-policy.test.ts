import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { Settings } from "../types.generated.ts";
import { applySettingsForm, excludedFoldersProblem, normalizeSettings, SETTINGS_LIMITS } from "./settings-policy.ts";

const current: Settings = {
  excludedFolders: [],
  searchTitleWeight: 3,
  searchHeadingWeight: 2,
  searchTagWeight: 2,
  searchContentWeight: 1,
  recencyBoost: 0,
  autosaveDelayMs: 900,
  undoStackMax: 100,
  imageWebpQuality: 0.8,
};

const form = { excludedFoldersText: "", autosaveDelayMs: 900, undoStackMax: 100, imageWebpQuality: 0.8 };

describe("applySettingsForm", () => {
  it("clamps each value to its shared limit", () => {
    expect(applySettingsForm(current, { ...form, autosaveDelayMs: 1, undoStackMax: 1, imageWebpQuality: 7 })).toMatchObject({
      autosaveDelayMs: SETTINGS_LIMITS.autosaveDelayMs.min,
      undoStackMax: SETTINGS_LIMITS.undoStackMax.min,
      imageWebpQuality: SETTINGS_LIMITS.imageWebpQuality.max,
    });
    expect(applySettingsForm(current, { ...form, imageWebpQuality: 0 }).imageWebpQuality)
      .toBe(SETTINGS_LIMITS.imageWebpQuality.min);
    expect(applySettingsForm(current, { ...form, autosaveDelayMs: 1e12, undoStackMax: 1e9 })).toMatchObject({
      autosaveDelayMs: SETTINGS_LIMITS.autosaveDelayMs.max,
      undoStackMax: SETTINGS_LIMITS.undoStackMax.max,
    });
  });

  it("brings stored values the form does not edit into the server range", () => {
    const stored = { ...current, searchTitleWeight: 5000, recencyBoost: -1, autosaveDelayMs: 0, undoStackMax: 1e7 };
    expect(applySettingsForm(stored, form)).toMatchObject({
      searchTitleWeight: SETTINGS_LIMITS.searchWeight.max,
      recencyBoost: SETTINGS_LIMITS.searchWeight.min,
    });
    expect(normalizeSettings(stored)).toMatchObject({
      autosaveDelayMs: SETTINGS_LIMITS.autosaveDelayMs.min,
      undoStackMax: SETTINGS_LIMITS.undoStackMax.max,
      searchTitleWeight: SETTINGS_LIMITS.searchWeight.max,
    });
  });

  it("keeps the current value for a non-finite entry", () => {
    expect(applySettingsForm(current, {
      ...form,
      autosaveDelayMs: Number.NaN,
      undoStackMax: Infinity,
      imageWebpQuality: Number.NaN,
    })).toMatchObject({ autosaveDelayMs: 900, undoStackMax: 100, imageWebpQuality: 0.8 });
  });

  it("rounds integer settings so the backend can store them", () => {
    expect(applySettingsForm(current, { ...form, autosaveDelayMs: 400.6, undoStackMax: 50.4 }))
      .toMatchObject({ autosaveDelayMs: 401, undoStackMax: 50 });
  });

  it("splits excluded folders on commas and leaves other settings untouched", () => {
    const next = applySettingsForm(current, { ...form, excludedFoldersText: " a, ,b c " });
    expect(next.excludedFolders).toStrictEqual(["a", "b c"]);
    expect(next.searchTitleWeight).toBe(3);
  });

  it.each(["a/b", "a\\b", "..", ".", "ok, nested/dir", "a\0b"])("rejects the excluded folder entry %j", (text) => {
    expect(excludedFoldersProblem(text)).toMatch(/single folder name/);
    expect(() => applySettingsForm(current, { ...form, excludedFoldersText: text })).toThrow(/single folder name/);
  });

  it("accepts an empty list and dotted names", () => {
    expect(excludedFoldersProblem("")).toBeNull();
    expect(excludedFoldersProblem(" .git, ..cache, a.b ")).toBeNull();
  });
});

describe("SETTINGS_LIMITS", () => {
  const rust = readFileSync(resolve(import.meta.dirname, "../../../src/api_types.rs"), "utf8");

  function rustRange(name: string): { min: number; max: number } {
    const match = new RegExp(`pub const ${name}: RangeInclusive<\\w+> = ([0-9_.]+)\\.\\.=([0-9_.]+);`).exec(rust);
    if (match === null) throw new Error(`${name} not found in src/api_types.rs`);
    return { min: Number(match[1]!.replaceAll("_", "")), max: Number(match[2]!.replaceAll("_", "")) };
  }

  it("matches the ranges the server validates", () => {
    expect(SETTINGS_LIMITS.autosaveDelayMs).toMatchObject(rustRange("AUTOSAVE_DELAY_MS_RANGE"));
    expect(SETTINGS_LIMITS.undoStackMax).toMatchObject(rustRange("UNDO_STACK_MAX_RANGE"));
    expect(SETTINGS_LIMITS.imageWebpQuality).toMatchObject(rustRange("IMAGE_WEBP_QUALITY_RANGE"));
    expect(SETTINGS_LIMITS.searchWeight).toMatchObject(rustRange("SEARCH_WEIGHT_RANGE"));
  });
});
