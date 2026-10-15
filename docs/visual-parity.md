# Native visual parity

The parity corpus compares Tansu2's web UI with two separate references from `~/d/tansu`:

- `native-current` images are captures of the existing AppKit application and are the reference for the shell, notes, tabs, outline, find, and current search surfaces.
- `design-target` images are approved visual designs for transient surfaces. They are not screenshots of production native behavior.
- `design-preview` images show transient surfaces in a full-window composition. They are not pixel targets for production Tansu.

The reference and browser scenes have separate identities in [scenes.ts](../tests/visual-parity/scenes.ts). The imported native bundle is versioned under [native-oracle/v1](../tests/visual-parity/native-oracle/v1/). It contains the literal Markdown fixtures, native screenshots, repeated captures, full fixture hashes, design-target hashes, and fixture-specific HEIC-to-WebP browser derivatives. The parity run copies each fixture to a private vault, config root, and data root under `.work/tmp/visual-parity/<run-id>/<scene-id>/`. It does not read the Tansu checkout or a configured user vault.

## Oracle provenance

The native exporter in `~/d/tansu` uses the existing AppKit visual harness for 2× window-content captures and records the native view tree, source files, and repeated-capture score. It writes under `.work/tmp/visual-parity-oracle/` by default or to `TANSU_VISUAL_ORACLE_OUTPUT`. It does not write into the checked-in native PNG fixture directories. Its implementation is test-only. The imported corpus records native source commit `4a1bd9b9cefc70c98e6724c0f8516d39cc64bb26` and the full environment in `manifest.json`.

The corpus includes the four `NativeVaultSurfaceVisualTests` notes and the frozen Claude Code note, search companion, and 17 HEIC attachments. Source Markdown and original HEIC bytes remain unchanged. The browser derivative map serves fixture-specific WebP files because the tested browser does not decode those HEIC files in this harness. Original and derivative checksums and dimensions are recorded separately in `manifest.json` and `browser-derivatives/manifest.json`. The original bytes remain the source of truth.

The seven approved design PNGs are copied without modification and checked against their SHA-256 and dimensions. Their checksums are in `design-target/manifest.json`. The previews are stored separately and are labeled as composition references.

## Reproducing captures

On the same Aqua macOS host that produced the native bundle:

```sh
cd ~/d/tansu
scripts/export-visual-oracle.sh

cd ~/d/tansu2
make visual-oracle-import
TANSU_VISUAL_PARITY_BROWSER=webkit TANSU_VISUAL_PARITY_SCENES=chrome-900x640,tabs-markdown-1040x720,markdown-lower-1040x720,empty-900x640,find-1040x720,find-design-target-1040x720,search-empty-900x640,search-no-results-900x640,search-results-900x640,command-palette-context-900x640,command-palette-panel,recent-notes-context-900x640,recent-notes-panel,rename-context-900x640,rename-panel make visual-parity
make visual-parity-report RUN_ID=2026-10-15T13-08-44-852Z
```

The desktop run excludes only `narrow-520x720`. `make visual-parity` defaults to Playwright WebKit and runs every scene when `TANSU_VISUAL_PARITY_SCENES` is unset. Set it to a comma-separated list for focused captures. Set `TANSU_VISUAL_PARITY_BROWSER=chromium` or `firefox` for secondary browser checks. `make visual-parity-acceptance` runs the full WebKit matrix and exits nonzero if any gate is red. Reports and galleries remain under `.work/tmp/visual-parity/<run-id>/`, including when a pixel gate fails.

`make visual-parity-fault-check` deliberately introduces a 2-point translation, wrong capture width, font-size change, modal offset, altered fixture image, and wrong note source. It expects geometry, dimension, pixel, or fixture-hash validation to fail and stores each red report. The two source faults mutate only that run's copied fixture.

The separate `node bench/visual-review.mjs` suite uses synthetic Tansu2 smoke fixtures. It is a browser-only layout and state review, not native parity. Set `TANSU_VISUAL_REVIEW_WIDTHS=1280,1440` to capture those desktop widths and their 2× counterparts.

## Capture and comparison contract

Each parity scene creates its own vault, data store, and config. The named actions in `scenes.ts` select notes, pin and order tabs, open find, search, command palette, recent notes, and rename surfaces, and check the visible state and source hashes before capture. Captures use light appearance, `en-US`, UTC, reduced motion, `document.fonts.ready`, decoded images, and two animation frames after the last layout change. Only the blinking editor caret is suppressed for capture.

Window captures use native point dimensions at DPR 2, with no scaling or registration. Panel-only targets are captured with transparent margins at their exact target sizes. Comparisons use `odiff --threshold 0.1 --parsable-stdout`. The harness saves antialias-aware and raw results for exact full frames and named regions. `odiff` exit code 22 is treated as a valid changed-image result when it includes a score. Dimension and tool errors remain failures. Each run writes actuals, references, diff images, overlays, ROI crops, geometry, scores, and `index.html`.

Native-current full-frame gates are 3% for the sparse empty scene and 6% for other scenes. Native critical regions allow 10%. Design-target full-frame and named focus-region gates are 1%. The harness declares these limits. A repeated native capture does not set a general noise floor for comparing AppKit and WebKit. They rasterize system text and effects differently. The native repeat captures in this bundle changed 0% of pixels. Text scenes still differ by several percentage points. The harness reports both AA and raw scores without masking or blurring either image.

## Environment and limits

The captured environment was macOS 27.0 build 26A428, Aqua, arm64, and 2× scale. It used Swift 6.4.0, Deno 2.9.7, Node 26.11.1, pnpm 12.13.0, Playwright 1.64.0, WebKit 27.2, and odiff 4.3.8. The campaign requested macOS 26. This is a same-host 2× comparison on macOS 27, not a macOS 26 acceptance run. No Apple font files are copied or installed.

CSS `backdrop-filter: blur(5px)` is present for modal search. In the tested Playwright WebKit capture, the computed style and `CSS.supports` report blur support, but captured pixels keep the underlying editor sharp. A separate headful WebKit capture showed the same result. Applying `filter: blur()` to the app's underlying content increased the difference between AppKit and WebKit captures. The browser uses CSS blur, and the mismatch remains visible. No screenshot is used as UI content.

No new runtime or visual dependencies were added. The parity harness uses the repository's existing Playwright, Node, Deno, and odiff tooling.
