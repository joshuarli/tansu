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
  it("clamps, rounds, and carries stored values into range", () => {
    const stored = {
      ...current,
      searchTitleWeight: 5000,
      recencyBoost: -1,
      autosaveDelayMs: 0,
      undoStackMax: 1e7,
    };
    const cases: Array<{
      stored?: Settings;
      form?: Partial<typeof form>;
      expected: Record<string, number | string[]>;
    }> = [
      {
        form: { autosaveDelayMs: 1, undoStackMax: 1, imageWebpQuality: 7 },
        expected: {
          autosaveDelayMs: SETTINGS_LIMITS.autosaveDelayMs.min,
          undoStackMax: SETTINGS_LIMITS.undoStackMax.min,
          imageWebpQuality: SETTINGS_LIMITS.imageWebpQuality.max,
        },
      },
      {
        form: { imageWebpQuality: 0 },
        expected: { imageWebpQuality: SETTINGS_LIMITS.imageWebpQuality.min },
      },
      {
        form: { autosaveDelayMs: 1e12, undoStackMax: 1e9 },
        expected: {
          autosaveDelayMs: SETTINGS_LIMITS.autosaveDelayMs.max,
          undoStackMax: SETTINGS_LIMITS.undoStackMax.max,
        },
      },
      {
        stored,
        expected: {
          searchTitleWeight: SETTINGS_LIMITS.searchWeight.max,
          recencyBoost: SETTINGS_LIMITS.searchWeight.min,
        },
      },
      {
        form: { autosaveDelayMs: Number.NaN, undoStackMax: Infinity, imageWebpQuality: Number.NaN },
        expected: { autosaveDelayMs: 900, undoStackMax: 100, imageWebpQuality: 0.8 },
      },
      {
        form: { autosaveDelayMs: 400.6, undoStackMax: 50.4 },
        expected: { autosaveDelayMs: 401, undoStackMax: 50 },
      },
    ];
    for (const { stored: input, form: overrides, expected } of cases) {
      expect(
        applySettingsForm(input ?? current, { ...form, ...overrides }),
      ).toMatchObject(expected);
    }
    expect(normalizeSettings(stored)).toMatchObject({
      autosaveDelayMs: SETTINGS_LIMITS.autosaveDelayMs.min,
      undoStackMax: SETTINGS_LIMITS.undoStackMax.max,
      searchTitleWeight: SETTINGS_LIMITS.searchWeight.max,
    });

    const next = applySettingsForm(current, { ...form, excludedFoldersText: " a, ,b c " });
    expect(next.excludedFolders).toStrictEqual(["a", "b c"]);
    expect(next.searchTitleWeight).toBe(3);
  });

  it("accepts only single folder names in the excluded list", () => {
    for (const text of ["a/b", String.raw`a\b`, "..", ".", "ok, nested/dir", "a\0b"]) {
      expect(excludedFoldersProblem(text)).toMatch(/single folder name/);
      expect(() => applySettingsForm(current, { ...form, excludedFoldersText: text })).toThrow(
        /single folder name/,
      );
    }
    for (const text of ["", " .git, ..cache, a.b "]) {
      expect(excludedFoldersProblem(text)).toBeNull();
    }
  });
});

describe("SETTINGS_LIMITS", () => {
  const rust = readFileSync(resolve(import.meta.dirname, "../../../crates/tansu-api-types/src/lib.rs"), "utf8")
    .replace(
      "tansu_search_policy::SearchWeightPolicy::MAX",
      /pub const MAX: f32 = ([0-9_.]+);/s.exec(
        readFileSync(resolve(import.meta.dirname, "../../../crates/tansu-search-policy/src/lib.rs"), "utf8"),
      )?.[1] ?? "unresolved",
    );

  function rustRange(name: string): { min: number; max: number } {
    const match = new RegExp(`pub const ${name}: RangeInclusive<\\w+> =\\s*([0-9_.]+)\\.\\.=([0-9_.]+);`).exec(rust);
    if (match === null) throw new Error(`${name} not found in crates/tansu-api-types/src/lib.rs`);
    return { min: Number(match[1]!.replaceAll("_", "")), max: Number(match[2]!.replaceAll("_", "")) };
  }

  it("matches the ranges the server validates", () => {
    expect(SETTINGS_LIMITS.autosaveDelayMs).toMatchObject(rustRange("AUTOSAVE_DELAY_MS_RANGE"));
    expect(SETTINGS_LIMITS.undoStackMax).toMatchObject(rustRange("UNDO_STACK_MAX_RANGE"));
    expect(SETTINGS_LIMITS.imageWebpQuality).toMatchObject(rustRange("IMAGE_WEBP_QUALITY_RANGE"));
    expect(SETTINGS_LIMITS.searchWeight).toMatchObject(rustRange("SEARCH_WEIGHT_RANGE"));
  });
});
