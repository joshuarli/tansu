import { describe, expect, it } from "vitest";
import type { Settings } from "../types.generated.ts";
import { applySettingsForm, SETTINGS_LIMITS } from "./settings-policy.ts";

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
    const next = applySettingsForm(current, { ...form, excludedFoldersText: " a, ,b/c " });
    expect(next.excludedFolders).toStrictEqual(["a", "b/c"]);
    expect(next.searchTitleWeight).toBe(3);
  });
});
