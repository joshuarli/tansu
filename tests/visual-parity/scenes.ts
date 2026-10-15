import type { VisualCaptureType, VisualOracleKind } from "../../bench/native-parity-types.ts";

export type NativeParityAction =
  | { kind: "open-notes"; names: string[] }
  | { kind: "select-note"; name: string }
  | { kind: "pin-note" }
  | { kind: "find"; query: string; expectedCount: number; close?: boolean }
  | { kind: "search"; query: string; submit?: boolean }
  | { kind: "search-history"; query: string }
  | { kind: "open-command" }
  | { kind: "open-recent" }
  | { kind: "rename" }
  | { kind: "prime-recent"; names: string[]; selected: string; pin: string[] };

export interface NativeParityScene {
  id: string;
  captureType: VisualCaptureType;
  pointWidth: number;
  pointHeight: number;
  sourceSet: "claude-code" | "surface" | "empty";
  actions: NativeParityAction[];
  expectedActive?: string;
  expectedOpen?: string[];
  expectedPinned?: string[];
  expectedText?: string;
  expectedSearchResultCount?: number;
  nativeCurrent?: string;
  designTarget?: string;
  designPreview?: string;
  targetFocusRegionPx?: [number, number, number, number];
}

export const NATIVE_PARITY_SCENES: readonly NativeParityScene[] = [
  {
    id: "chrome-900x640",
    captureType: "window-content",
    pointWidth: 900,
    pointHeight: 640,
    sourceSet: "claude-code",
    actions: [{ kind: "open-notes", names: ["claude code is the inflection point.md"] }],
    expectedActive: "claude code is the inflection point.md",
    expectedOpen: ["claude code is the inflection point.md"],
    nativeCurrent: "native-current/chrome-900x640/actual.png",
  },
  {
    id: "tabs-markdown-1040x720",
    captureType: "window-content",
    pointWidth: 1040,
    pointHeight: 720,
    sourceSet: "surface",
    actions: [
      { kind: "open-notes", names: ["Project Atlas.md"] },
      { kind: "pin-note" },
      { kind: "open-notes", names: ["Reading Queue.md"] },
      { kind: "pin-note" },
      { kind: "open-notes", names: ["Gallery.md", "Studio Dashboard.md"] },
    ],
    expectedActive: "Studio Dashboard.md",
    expectedOpen: ["Project Atlas.md", "Reading Queue.md", "Gallery.md", "Studio Dashboard.md"],
    expectedPinned: ["Project Atlas.md", "Reading Queue.md"],
    nativeCurrent: "native-current/tabs-markdown-1040x720/actual.png",
  },
  {
    id: "markdown-lower-1040x720",
    captureType: "window-content",
    pointWidth: 1040,
    pointHeight: 720,
    sourceSet: "surface",
    actions: [
      { kind: "open-notes", names: ["Project Atlas.md"] },
      { kind: "pin-note" },
      { kind: "open-notes", names: ["Reading Queue.md"] },
      { kind: "pin-note" },
      { kind: "open-notes", names: ["Gallery.md", "Studio Dashboard.md"] },
      { kind: "find", query: 'let workspace = "native"', expectedCount: 1, close: true },
    ],
    expectedActive: "Studio Dashboard.md",
    expectedOpen: ["Project Atlas.md", "Reading Queue.md", "Gallery.md", "Studio Dashboard.md"],
    expectedPinned: ["Project Atlas.md", "Reading Queue.md"],
    expectedText: 'let workspace = "native"',
    nativeCurrent: "native-current/markdown-lower-1040x720/actual.png",
  },
  {
    id: "narrow-520x720",
    captureType: "window-content",
    pointWidth: 520,
    pointHeight: 720,
    sourceSet: "surface",
    actions: [{ kind: "open-notes", names: ["Studio Dashboard.md"] }],
    expectedActive: "Studio Dashboard.md",
    expectedOpen: ["Studio Dashboard.md"],
    nativeCurrent: "native-current/narrow-520x720/actual.png",
  },
  {
    id: "empty-900x640",
    captureType: "window-content",
    pointWidth: 900,
    pointHeight: 640,
    sourceSet: "empty",
    actions: [],
    nativeCurrent: "native-current/empty-900x640/actual.png",
  },
  {
    id: "find-1040x720",
    captureType: "window-content",
    pointWidth: 1040,
    pointHeight: 720,
    sourceSet: "surface",
    actions: [
      { kind: "open-notes", names: ["Studio Dashboard.md"] },
      { kind: "find", query: "workspace", expectedCount: 7 },
    ],
    expectedActive: "Studio Dashboard.md",
    expectedOpen: ["Studio Dashboard.md"],
    nativeCurrent: "native-current/find-1040x720/actual.png",
  },
  {
    id: "find-design-target-1040x720",
    captureType: "window-content",
    pointWidth: 1040,
    pointHeight: 720,
    sourceSet: "surface",
    actions: [
      { kind: "open-notes", names: ["Gallery.md", "Studio Dashboard.md"] },
      { kind: "find", query: "workspace", expectedCount: 7 },
    ],
    expectedActive: "Studio Dashboard.md",
    expectedOpen: ["Gallery.md", "Studio Dashboard.md"],
    designTarget: "design-target/vault-surface-find.png",
    targetFocusRegionPx: [1360, 128, 696, 64],
  },
  {
    id: "search-empty-900x640",
    captureType: "window-content",
    pointWidth: 900,
    pointHeight: 640,
    sourceSet: "surface",
    actions: [
      { kind: "open-notes", names: ["Gallery.md"] },
      { kind: "search-history", query: "workspace" },
      { kind: "search", query: "" },
    ],
    expectedActive: "Gallery.md",
    expectedOpen: ["Gallery.md"],
    nativeCurrent: "native-current/search-empty-900x640/actual.png",
    designTarget: "design-target/vault-surface-search-empty.png",
    targetFocusRegionPx: [340, 136, 1120, 634],
  },
  {
    id: "search-no-results-900x640",
    captureType: "window-content",
    pointWidth: 900,
    pointHeight: 640,
    sourceSet: "surface",
    actions: [
      { kind: "open-notes", names: ["Gallery.md"] },
      { kind: "search", query: "quasar" },
    ],
    expectedActive: "Gallery.md",
    expectedOpen: ["Gallery.md"],
    expectedText: "No results for “quasar”",
    nativeCurrent: "native-current/search-no-results-900x640/actual.png",
    designTarget: "design-target/vault-surface-search-no-results.png",
    targetFocusRegionPx: [340, 136, 1120, 634],
  },
  {
    id: "search-results-900x640",
    captureType: "window-content",
    pointWidth: 900,
    pointHeight: 640,
    sourceSet: "claude-code",
    actions: [
      { kind: "open-notes", names: ["claude code is the inflection point.md"] },
      { kind: "search", query: "claude" },
    ],
    expectedActive: "claude code is the inflection point.md",
    expectedOpen: ["claude code is the inflection point.md"],
    expectedSearchResultCount: 2,
    nativeCurrent: "native-current/search-results-900x640/actual.png",
    designTarget: "design-target/search-modal-baseline.png",
    targetFocusRegionPx: [340, 136, 1120, 634],
  },
  {
    id: "command-palette-context-900x640",
    captureType: "in-context",
    pointWidth: 900,
    pointHeight: 640,
    sourceSet: "surface",
    actions: [
      { kind: "open-notes", names: ["Gallery.md"] },
      { kind: "open-command" },
    ],
    expectedActive: "Gallery.md",
    expectedOpen: ["Gallery.md"],
    nativeCurrent: "native-current/command-palette-context-900x640/actual.png",
    designPreview: "design-target/previews/command-palette-in-context.png",
  },
  {
    id: "command-palette-panel",
    captureType: "panel-only",
    pointWidth: 520,
    pointHeight: 384,
    sourceSet: "surface",
    actions: [
      { kind: "open-notes", names: ["Gallery.md"] },
      { kind: "open-command" },
    ],
    expectedActive: "Gallery.md",
    expectedOpen: ["Gallery.md"],
    nativeCurrent: "native-current/command-palette-panel/actual.png",
    designTarget: "design-target/vault-surface-command-palette.png",
    targetFocusRegionPx: [32, 32, 976, 704],
  },
  {
    id: "recent-notes-context-900x640",
    captureType: "in-context",
    pointWidth: 900,
    pointHeight: 640,
    sourceSet: "surface",
    actions: [{ kind: "prime-recent", names: ["Gallery.md", "Studio Dashboard.md", "Project Atlas.md", "Reading Queue.md"], selected: "Gallery.md", pin: ["Project Atlas.md", "Reading Queue.md"] }, { kind: "open-recent" }],
    expectedActive: "Gallery.md",
    expectedOpen: ["Gallery.md"],
    nativeCurrent: "native-current/recent-notes-context-900x640/actual.png",
    designPreview: "design-target/previews/recent-notes-in-context.png",
  },
  {
    id: "recent-notes-panel",
    captureType: "panel-only",
    pointWidth: 560,
    pointHeight: 424,
    sourceSet: "surface",
    actions: [{ kind: "prime-recent", names: ["Gallery.md", "Studio Dashboard.md", "Project Atlas.md", "Reading Queue.md"], selected: "Gallery.md", pin: ["Project Atlas.md", "Reading Queue.md"] }, { kind: "open-recent" }],
    expectedActive: "Gallery.md",
    expectedOpen: ["Gallery.md"],
    nativeCurrent: "native-current/recent-notes-panel/actual.png",
    designTarget: "design-target/vault-surface-recent-notes.png",
    targetFocusRegionPx: [32, 32, 1056, 784],
  },
  {
    id: "rename-context-900x640",
    captureType: "in-context",
    pointWidth: 900,
    pointHeight: 640,
    sourceSet: "surface",
    actions: [{ kind: "open-notes", names: ["Studio Dashboard.md"] }, { kind: "rename" }],
    expectedActive: "Studio Dashboard.md",
    expectedOpen: ["Studio Dashboard.md"],
    nativeCurrent: "native-current/rename-context-900x640/actual.png",
    designPreview: "design-target/previews/rename-in-context.png",
  },
  {
    id: "rename-panel",
    captureType: "panel-only",
    pointWidth: 420,
    pointHeight: 188,
    sourceSet: "surface",
    actions: [{ kind: "open-notes", names: ["Studio Dashboard.md"] }, { kind: "rename" }],
    expectedActive: "Studio Dashboard.md",
    expectedOpen: ["Studio Dashboard.md"],
    nativeCurrent: "native-current/rename-panel/actual.png",
    designTarget: "design-target/vault-surface-rename.png",
    targetFocusRegionPx: [16, 16, 808, 344],
  },
] satisfies readonly NativeParityScene[];

export const VISUAL_PARITY_GATES: Readonly<Record<VisualOracleKind, number>> = {
  "native-current": 6,
  "design-target": 1,
  "browser-only": 0,
};
