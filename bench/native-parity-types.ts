export type VisualOracleKind = "native-current" | "design-target" | "browser-only";

export type VisualCaptureType = "window-content" | "in-context" | "panel-only";

export interface NativeOracleSourceFile {
  relativePath: string;
  sha256: string;
  role: string;
}

export interface NativeOracleDesignTarget {
  file: string;
  sha256: string;
  widthPx: number;
  heightPx: number;
  sourcePath: string;
  focusRegionPx: number[];
}

export interface NativeOracleViewFrame {
  className: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface NativeOracleTextMetrics {
  className: string;
  fontName?: string;
  fontSize?: number;
  insetX: number;
  insetY: number;
  viewportWidth: number;
  viewportHeight: number;
}

export interface NativeOracleColor {
  red: number;
  green: number;
  blue: number;
  alpha: number;
}

export interface NativeOracleScene {
  sceneID: string;
  oracleKind: "native-current";
  captureType: VisualCaptureType;
  pointWidth: number;
  pointHeight: number;
  backingScale: number;
  pixelWidth: number;
  pixelHeight: number;
  actualSHA256: string;
  repeatSHA256: string;
  repeatChangedPixelPercent: number;
  sourceFiles: NativeOracleSourceFile[];
  selectedNotes: string[];
  openNotes: string[];
  pinnedNotes: string[];
  selection: string | null;
  scrollState: string | null;
  query: string | null;
  viewFrames: NativeOracleViewFrame[];
  textMetrics: NativeOracleTextMetrics[];
  colors: Record<string, NativeOracleColor>;
}

export interface NativeOracleManifest {
  schemaVersion: 1;
  sourceRepository: string;
  sourceCommit: string;
  sourceWorkingTreeDirty: boolean;
  operatingSystem: string;
  architecture: string;
  appearance: "Aqua";
  backingScale: 2;
  swiftVersion: string;
  odiffVersion: string;
  sourceFiles: NativeOracleSourceFile[];
  designTargets: NativeOracleDesignTarget[];
  scenes: NativeOracleScene[];
}
