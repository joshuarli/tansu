# Tansu2: Native Tansu Visual-Parity Campaign

## Execution directive — unattended coding agent

Work primarily in `~/d/tansu2`, with `~/d/tansu` as the **authoritative native visual reference** and as the location of a **test-only** oracle exporter. Execute this campaign sequentially, with measured visual convergence rather than a one-off CSS refresh. Implement and run what the current macOS environment supports. Do not ask the user for aesthetic choices: **native Tansu is the design specification**. Do not claim parity or mark a stage complete when its capture/comparison gates fail. Continue fixing the highest-impact mismatch until the specified gates pass, or report a concrete, reproducible infrastructure limitation with the measured work completed.

Do **not** commit, push, deploy, change production Tansu behavior, alter either repository's real-vault configuration or user notes, re-record approved native design-target PNGs, or relax comparisons simply to turn a test green. Read each repository's `AGENTS.md` and relevant docs before edits. No mobile website redesign, PWA or iPhone work in this campaign. Maintain the standalone Rust+TypeScript Tansu2 architecture, CodeMirror/Atomic editing engine, Tantivy, auth, storage, and API contracts; visual changes must not degrade document editing or data safety.

### Starting source snapshots, for orientation only

At preparation time (2026-10-14), `~/d/tansu2` matched `joshuarli/tansu2` master at `ead8f79283a2c9305131683602c6439d6c343ca9`; `~/d/tansu` matched `joshuarli/tansu` master at `4a1bd9b9cefc70c98e6724c0f8516d39cc64bb26`. These are **not checkout commands**. Inspect the actual local HEAD and dirty files, preserve user changes, and work against the current working tree. Do not reset the repositories to these SHAs.

### Why this work is necessary

The desktop redesign campaign succeeded primarily at architecture and interaction. Tansu2's current `bench/visual-review.mjs` takes Playwright Chromium screenshots of **Tansu2-specific synthetic notes** and checks limited self-defined metrics (including a 17px / 27.2px editor), but has no native Tansu golden reference and performs no AppKit-to-browser `odiff`. Its CSS in `web/static/app.css` still defines a 224–304px responsive sidebar, a 76ch reading column, a 40px toolbar, additional metadata gaps, and different tab strip dimensions. `web/ts/editor/editor.css` and the vendored Atomic theme further control typography and block rendering.

In contrast, native Tansu exposes `NativeVaultAppearance.editorConfiguration()` with a 220pt sidebar, 17pt system font, 760pt reading width, 39pt horizontal and 44pt vertical text insets, heading multipliers `[1.9,1.45,1.2,1.0,0.9,0.82]`, list-indent and paragraph spacing policies; `VaultViewController` hides the sidebar below 540pt, positions its outline 96pt from the top, and places a 62pt tab strip immediately above the native editor. Its transient surfaces have explicit geometry, palette, shadow, and blur rules.

**The target is the native application's observed pixels and intended design targets, not a vaguely similar aesthetic.** CSS, DOM composition, Atomic/CodeMirror presentation extensions, iconography, and transient surfaces should all change as necessary to reproduce it.

## Non-negotiable reference classification

**Do not conflate these three oracle types:**

1. **Native-current captures:** screenshots actually rendered by Tansu's production AppKit/TextKit UI using deterministic fixtures. These are the authoritative references for the existing shell, reading surface, tabs, outline, narrow state, and ordinary empty state.
2. **Approved design targets:** seven checked-in PNGs documented explicitly in `~/d/tansu/Tests/TansuAppTests/Fixtures/README.md` and `~/d/tansu/design/transient-surfaces/manifest.json` as **design targets, not screenshots of a finished production redesign**. These include search, search-empty, search-no-results, command palette, recent notes, rename, and find. Preserve their hash and dimensional contracts. It is acceptable—and required—to aim Tansu2 at these desired designs, but the report must not claim native-production parity for them. There are also in-context preview images in `design/transient-surfaces/previews/`; these are design references, not evidence that native code already renders them.
3. **Tansu2-only states:** authentication, conflict recovery, revision-history views, some settings and failures. Preserve them as separate browser regressions, harmonious with native style, without fabricating a native comparison.

If the native production implementation of a design-target state differs, export **both** `native-current` and `design-target` images for that scene and label them accurately. Never satisfy a design-target fixture by replacing it with a native-current screenshot or vice versa.

## Source map (read before implementation)

Native `~/d/tansu`:

- `Tests/TansuAppTests/NativeVaultVisualHarness.swift`: actual 2× AppKit capture, editor layout/image readiness, cross-window panel compositing, odiff invocation and detailed artifacts.
- `Tests/TansuAppTests/NativeVaultChromeVisualTests.swift`: 900×640pt image-heavy chrome scene; `Fixtures/vault-chrome-baseline.png`.
- `Tests/TansuAppTests/NativeVaultSurfaceVisualTests.swift`: four-note `SurfaceFixtureContent` embedded directly in Swift; 1040×720pt tabs/Markdown/find/lower content, 520×720pt narrow, 900×640pt empty/search/panels.
- `Tests/TansuAppTests/NativeVaultSearchModalVisualTests.swift`: 900×640pt search over the real Claude Code corpus.
- `Tests/TansuAppTests/Fixtures/ClaudeCodeNote/`: real Markdown+HEIC attachments; `Fixtures/ClaudeSearchNotes.md`.
- `Tests/TansuAppTests/Fixtures/README.md`; `design/transient-surfaces/{manifest.json,specification.json,README.md,previews/}`: design-only targets, provenance and pixel regions.
- `Sources/tansu/UI/{NativeVaultAppearance,NativeVaultViewController,NativeVaultTabStripView,NativeVaultFindBar,NativeVaultSearchPanel,NativeVaultPanels,NativeVaultTransientStyle}.swift`.
- `Sources/MarkdownEngine/` for actual block styling, heading behavior, source-sensitive decorations, image sizing, tables and cursor behavior. `docs/LAYOUT.md` and `PERF.md`.

Browser `~/d/tansu2`:

- `bench/visual-review.mjs`: existing Tansu2-only screenshot smoke suite; retain and do not mislabel it parity.
- `web/static/app.css`: shell, sidebar, tabs, reading column, editor host, transient surfaces.
- `web/ts/view.ts`, `web/ts/app.ts`: DOM structure and app state; avoid mount/reconciliation regressions.
- `web/ts/editor/{codemirror-adapter.ts,editor.css}` and `web/ts/editor/vendor/atomic/`: styling and editor rendering/selection; preserve source and undo invariants.
- `docs/editor.md`, `docs/architecture.md`, `docs/performance.md`, existing browser E2E/bench and fixture generators.
- `Makefile`, `deno.json`, `package.json`: current build/test commands. Do not revert the recent Deno/TypeScript modernization.

## Desired deliverables

After completion, the repos must contain:

- A **native-only fixture export** runner in `~/d/tansu`, reusing existing test machinery and state construction, with a JSON manifest, source/capture provenance, actual native-current images, and checked-in design-target references copied into an **isolated export**; no changes to golden fixtures.
- A **standalone checked-in parity corpus** in `~/d/tansu2/tests/visual-parity/` including the necessary source Markdown, deterministic attachments or their fixture-specific, documented browser derivatives, immutable reference PNGs, a typed manifest and hashes. Running Tansu2 must never require the Tansu checkout. No redistributed Apple font files.
- `~/d/tansu2/bench/native-parity.mjs` (or a similarly discoverable entrypoint) that runs an isolated browser app against copied native fixtures, captures matching scenes on **macOS 26 and 2× backing scale**, and invokes `odiff` on exactly dimension-matched screenshots and named crops. It must produce persisted actual/diff/overlay/score/geometry reports even when comparisons fail.
- Explicit commands such as `make visual-oracle-export` in Tansu (if appropriate), and `make visual-parity`, `make visual-parity-report`, `make visual-parity-acceptance` in Tansu2; add docs with reproducibility instructions.
- A **red-to-green visual convergence** on the specified scenes, including shell, typography, Markdown, tabs, sidebar, find, and design-target transient surfaces; no permanent screenshot-as-UI, anti-diff masks, or reference substitution.
- Existing unit, E2E, source-round-trip, search, and server test suites preserved. Add structural assertions that disallow the most likely visual regressions.
- An evidence-rich `docs/visual-parity.md`, a fixture provenance/scene catalog, and `docs/visual-parity-results.md` containing before/after comparisons, measured diff percentages, known platform-limited deltas, and explicit unmet targets.

## Stage 0 — Audit the actual trees and establish an untouched baseline

1. Read `AGENTS.md` in both repos. Record local HEADs, tool versions, git status, macOS version, display/backing scale, Swift toolchain, `odiff --version`, Node/Deno/pnpm and Playwright versions. Do not mutate tracked files during baseline collection.
2. Verify the supported target host: native Tansu requires macOS 26 / Aqua and `NativeVaultVisualHarness` **requires a 2× backing scale**. Do not quietly substitute a 1× screenshot, upscale, or run a Linux render and declare parity. If the host cannot run native screenshots, still implement portable fixtures, the exporter, browser captures and comparison tools; clearly mark native capture as blocked and retain red gates.
3. Run native visual tests **serially**, collecting current passes/failures. Some approved design-target tests are intentionally red; classify, do not suppress or overwrite. Preserve Tansu's original regression suite and flags.
4. Run Tansu2's existing visual review, E2E smoke, editor tests, and relevant benchmarks. Copy their before screenshots and metadata into `.work/tmp/visual-parity-baseline/`. Do not promote these self-referential images to native goldens.
5. Prepare a table mapping native scenes to actual Tansu2 UI actions and source fixture identities. Enumerate any semantic mismatch, especially active note, pinned order, search query/result ordering, reader versus editor mode, source caret/selection, toolbar visibility, and virtual title behavior. Resolve scene semantics, not just pixel cropping.

**Gate 0:** Baselines and scene map exist; target labels (`native-current`, `design-target`, `browser-only`) are correct; no fixture bytes changed.

## Stage 1 — Extend the existing Tansu AppKit capture infrastructure

**Do not reimplement screenshots from scratch.** Reuse `NativeVaultVisualHarness.awaitRenderingReadiness`, `render(view:)`, `renderWindowContentIncludingChildPanels(window:)`, its 2× scale check, caret suppression, `odiff` logic and layout readiness boundary. Extract the deterministic fixture builders currently private to `NativeVaultSurfaceVisualTests` into shared **test-only** helpers without changing test semantics.

1. Add a dedicated capture/export suite, for example `Tests/TansuAppTests/NativeVisualOracleExportTests.swift`, and an entrypoint script `scripts/export-visual-oracle.sh`. Exports go to an explicitly named directory outside tracked native golden paths (e.g. `.build/visual-parity-oracle/` or supplied `TANSU_VISUAL_ORACLE_OUTPUT`). Make exporter idempotent and incapable of overwriting the Tansu approved `Fixtures/*.png` targets. It must never set any `TANSU_UPDATE_NATIVE_VAULT_*` flags.
2. Reuse native fixture notes literally. Export their Markdown files as UTF-8 test inputs with exact source hashes and relative paths; do not manually rewrite or paraphrase content. Include the four-note `Studio Dashboard` corpus, a distinct empty vault, and the Claude Code note corpus with attachments. Preserve names, selected note, pin state, view state and tab ordering.
3. Capture **native-current** screenshots of these actual states (full window content, no window decorations):
   - `chrome-900x640`: `NativeVaultChromeVisualTests` actual app rendering of the Claude Code corpus;
   - `tabs-markdown-1040x720`: pinned/regular tab order, selected `Studio Dashboard`, outline, editor;
   - `markdown-lower-1040x720`: revealed `let workspace = "native"` lower in same document;
   - `narrow-520x720`: sidebar hidden by native threshold;
   - `empty-900x640`: empty vault layout;
   - `find-1040x720`: live native find with `workspace` and `1 of 7`;
   - `search-empty-900x640`, `search-no-results-900x640`, `search-results-900x640`: actual native AppKit state, separately from the **approved design target** PNGs;
   - full-window **in-context** command, recent notes and rename if possible, composited with native host/child panel placement using existing helper; separate component-only captures preserving transparent margins when needed.
4. Copy the original, immutable **design-target** PNGs (and optional design previews) to a separate `design-target/` directory, verifying them against `design/transient-surfaces/manifest.json` SHA-256 and dimensions. Never rewrite, auto-update or re-synthesize them.
5. Write structured per-scene manifest metadata: `sceneId`, `oracleKind`, source note paths/hashes, source repo commit, target SHA-256, appearance Aqua, macOS/build, architecture, capture points, backing scale, **exact pixel dimensions**, selected/open/pinned notes, caret/selection and scroll state, query state, asset mapping, capture type (`window-content`, `in-context`, `panel-only`), and reference region rectangles. For geometry emit native view rectangles in **window-content top-left points** plus text-inset and content viewport measurements. Record resolved sRGB NSColor values for the actual active Aqua appearance, effective NSFont name/size, source headings/line baselines where discoverable. Avoid relying on source-code constants alone.
6. Match the old native regression harness's expected behavior: wait for the correct editor document/revision and all visible embedded images; do not use a fixed sleep as readiness proof. Render app windows at exact content sizes and 2×; ensure no other window or OS chrome enters captures. Record capture failures with useful diagnostics.
7. For `panel-only` design targets, record exact target sizes: command 520×384pt (1040×768px), recent 560×424pt (1120×848px), rename 420×188pt (840×376px). Preserve transparent shadow margins. For design full-window references, search is 900×640pt (1800×1280px) and find 1040×720pt (2080×1440px). The design manifest is authoritative if sizes change.

**Gate 1:** On a supported macOS 26/2× host, the exporter generates reproducible, correctly labeled actual AppKit captures and immutable design references with byte hashes and complete manifests. Two repeated captures of the same deterministic scene must have a measured small native-to-native difference, and any nondeterminism must be fixed or documented before cross-render comparison. The exporter never changes native production app code or existing golden files.

## Stage 2 — Make Tansu2 consume the real native oracle

1. Add a reproducible import script to Tansu2, taking the exported oracle bundle (default `~/d/tansu/.build/visual-parity-oracle`), verifying hashes and expected dimensions, and copying it into a versioned `tests/visual-parity/native-oracle/`. Include fixture data and provenance. The imported corpus becomes standalone; there must be no runtime, build, test or release dependency on `~/d/tansu`.
2. Remove **synthetic content from the parity path**. Keep `bench/visual-review.mjs` for browser-only broad smoke tests; the parity harness must use the source Markdown from `NativeVaultSurfaceVisualTests` and frozen Claude fixture. Do not edit note content to make the screenshots easier to match. If frontmatter or filename-derived title needs a scene adapter, implement correct production behavior rather than rewriting the fixture.
3. Create one isolated Tansu2 vault data/config root per run and per scene. Populate it with the native fixture files and assets; ensure note selection, tabs, pin order, recents, session and search state match the manifest. Use the real Tansu2 APIs or deterministic catalog setup, not fake DOM content. Never touch a configured real vault or the global application state.
4. Resolve native `images/` and HEIC assets honestly. Safari/WebKit/Chromium support must be measured, not assumed. For any unsupported source format, preserve its original fixture bytes and original Markdown; use a **fixture-specific derivative image map** or a legitimate production asset-serving strategy, documenting pixel/color/size differences. Do not replace an actual image with a CSS block, generic placeholder, or screenshot crop to improve parity. Place image-heavy scenes in a separately measured tier if format decoding remains unresolved.
5. Define a named scene DSL/config in TypeScript or JSON. Each scene loads the same note/vault state and includes named browser actions (select note, pin/order tabs, scroll to specific source, open find, enter search query, wait for exact result count, open palette, rename, etc.). No selector-dependent guesswork about what 'looks loaded'. Assert expected source hashes, visible text, tab order, and overlay state before screenshot.

**Gate 2:** Identical semantic content and user-visible scene state in native and browser for every mapped case. Manifest hashes prove exact fixture provenance; independent and clean runs produce identical Tansu2 source state.

## Stage 3 — Build the browser screenshot/difference/geometry harness

1. Create `bench/native-parity.mjs` (prefer the existing Playwright and Node/Deno tooling). Default to **Playwright WebKit on the same macOS machine that generated native references**, at CSS viewport dimensions equal to the native window **point** size, `deviceScaleFactor: 2`. Example: 900×640 CSS viewport -> 1800×1280 PNG. Chromium is a secondary cross-browser compatibility/regression target, not a substitute native baseline. Keep Firefox browser smoke coverage if supported.
2. Fix appearance to light, locale, reduced motion, font/environment where controllable. Await authenticated/loaded app, settled CodeMirror session, `document.fonts.ready`, real image `decode()`, scroll/focus/overlay state, and at least two animation frames after the final relevant layout mutation. Disable actual animations for parity capture without changing final presentation design. Capture the same full window-content rectangle as Tansu; browser UI bars and system chrome excluded. Hide **only ephemeral caret/blinking insertion-point visuals** using a capture-specific style consistent with native caret suppression; never hide app controls or text.
3. **No resizing, fitting, translation, image registration or blurring** in acceptance. Native and web screenshots must have exact dimensions and stable coordinate systems. Diagnostic-only shifted/registered comparisons are allowed if clearly labeled and never used as passing output. For app modal windows, compare in-context composite to in-context composite; for panel-only baselines render the equivalent isolated transparent-background surface at its exact size, preserving shadow margins. Do not compare a panel-only PNG to a full browser screenshot.
4. Drive `odiff` with the native harness convention: `baseline.png actual.png diff.png --threshold 0.1 --parsable-stdout --antialiasing --fail-on-layout`. Also run an AA-disabled `odiff` pass as diagnostic. Handle success, changed-image, dimension mismatch, and other errors explicitly. Do not interpret `odiff` exit code 22 as process failure when the tool has produced a valid difference measurement, but do report its mismatch. Save both percentages and diff PNGs.
5. For every scene save, under `.work/tmp/visual-parity/<run-id>/<scene-id>/`: immutable-reference copy, full actual PNG, odiff/AA and raw diffs, 50/50 overlay, side-by-side image, optional blink animation, named ROI crops + diffs, `capture.json`, `geometry.json`, and `score.json`. Generate an `index.html` report with quick jump to worst ROI and before/after comparisons. Avoid copying, serving or redistributing font files.
6. Collect browser geometry from `getBoundingClientRect` and computed styles for sidebar, tab strip, selected tab, document viewport, first glyph baseline if measurable, heading blocks, editor scroll box, find strip, modal bounds, shadow margins, and key scroll anchors. Compare to native manifest coordinates **in points**, not pixel dimensions. Retain the raw values and quantitative differences.
7. Define region names: background/chrome, sidebar/outline, tabs, editor-frame, document-typography, Markdown tables, images, find, search-panel, modal/backdrop. Use exactly documented rectangles for design-target focus regions; freeze/approve new native-current ROIs before using them as gates. Require both full-frame and critical-ROI passing scores—no average that hides a broken editor under a large uniform background.
8. Explicitly calibrate inherent renderer differences: capture repeated native-vs-native runs, repeat browser-vs-browser runs, inspect glyph antialiasing on the **same macOS host**. Record a noise floor for each ROI. `odiff` is the principal pixel metric; use glyph-edge alignment, bounding-box/baseline error, line-break identity, or an SSIM-like perceptual view only as secondary diagnostics. Do not automatically exempt text, increase tolerance, or invent huge masks because the engines rasterize differently.
9. Preserve `bench/visual-review.mjs` as a distinct browser-only regression suite and document that it is **not** native parity. New parity tasks must be discoverable through Makefile/Deno scripts. Tests must fail on missing/incorrect oracle type, wrong SHA, dimensions, font readiness, source hash mismatch, incomplete image decode, unexpected overlay, or absent screenshot artifacts.

**Gate 3:** A clean run produces accurate **red baseline** metrics (not just PNGs) for all available native-current and design-target scenes, reproducible in the current supported macOS environment. The harness can demonstrate failure using deliberate 2px translation, wrong width, font-size, modal offset, altered image and wrong note source. Reports persist when the visual gate fails.

## Stage 4 — Converge the structural desktop shell FIRST

Use **native Tansu's installed UI** as the only aesthetic authority, not contemporary notes-app design references. Extract measured native tokens into a clearly named Tansu visual theme layer in Tansu2; document where AppKit dynamic colors resolve differently from web CSS.

Priority:

1. Exactly match full-window **Aqua** background; sidebar width 220pt (at fixed desktop sizes), no native divider, native 540pt sidebar-hide behavior, native outline y-position/row sizes and minimalist content. Do not preserve Tansu2's 224–304px responsive sidebar or its 54px collapsed rail simply because they already exist if they conflict with native target. Keep useful interactions, but map the visual presentation to native.
2. Match the 62pt tab strip height, top/side insets (native `NativeVaultTabStripView` uses stack edge insets of 24 top, 34 left, 6 bottom, 34 right), tab labels/icons, selected highlight, pin presentation, text weights, close control affordances and spacing. Match selected/pinned/normal visual states individually.
3. Eliminate/move persistent chrome absent in native captures. The current web `.toolbar` above the editor and `.editor-meta` blank spacer/inline tag row alter document origin. Native parity is not obtainable by adjusting a content margin while leaving an extra toolbar in the stack. Retain essential editing commands through keyboard/context or unobtrusive transient controls; do not invent a new permanent toolbar.
4. Match the native editor viewport origin, width and scroll geometry. Native reading width **760pt** and text insets **39pt horizontal / 44pt vertical** should be reproduced by actual measured geometry, not by approximating the first visible line using `76ch`, `15vw` offset and compensating arbitrary margins. Study how TextKit's inset combines with the reading column before translating into CSS and CodeMirror viewport padding.
5. Match title behavior (native's filename-derived virtual title and its document relationship), H1 body source and editing affordances without duplicating/hiding authored headings. Avoid changing note source to improve presentation. Match empty/narrow states and search orientation.
6. Match system colors from **resolved native screenshot/NSColor values**, not convenient warm-grays; use SF system font through browser system font family, not a downloaded Apple font. For SF Symbols absent from browser, use native-inspired CSS or original permissibly licensed vectors, with visually accurate size and stroke—never embed cropped screenshot glyphs.

After every set of changes, run the parity harness and inspect actual overlays/diffs. Prioritize the largest geometry error and full-frame mismatch before micro-tuning controls. Preserve event handlers and editor state identity.

**Gate 4:** Sidebar edges, tab-strip edges, selected-tab bounds, editor outer rectangle and reading text origin within **1 CSS point** of native on 900×640 and 1040×720 reference sizes (allow up to 2 points only where measured native font metrics demand it); responsive narrow 520×720 matches the native hidden-sidebar state. Background-only/chrome flat regions have low odiff differences; all core controls remain operable. Capture and report numeric geometry, not merely screenshots.

## Stage 5 — Match the MarkdownEngine reading and live-editing surface

CSS-only approximation is insufficient when CodeMirror/Atomic's decoration semantics create different **visible** artifacts. Preserve Atomic's raw Markdown document state, session-local undo, transaction tracking, find and save behavior; implement Tansu-specific theme/decorations/widgets where necessary. Do not reintroduce a custom `contentEditable` editor.

Converge against the native Markdown fixtures:

- Base 17pt/px SF system text, actual native line height/leading, paragraph spacing/line gaps and soft wrapping at the exact reading column width; heading 1–6 multipliers `[1.9, 1.45, 1.2, 1, .9, .82]` and heading top spacing `[.7,.55,.4,.3,.25,.2]` em; avoid simply applying default HTML heading margins.
- Rich text spans, bold/italic/strike/highlight, links (native same-color links), hidden/revealed Markdown punctuation, inline code (0.85× native font), fenced code styling (0.85× with 12pt horizontal indent and native paragraph spacing), blockquote inset/leading, horizontal rules.
- List markers and indentation (native configured `indentPerLevel: 27.5`, maximum nesting 3, extra line height 2), ordered lists, task checkboxes and interaction state, whitespace and hanging indents.
- Table column/cell spacing, rules, overflow/scroll, focused vs unfocused appearance, monospace code and syntax colors only where native actually displays them.
- Wiki links, local images and image widths/caps, image spacing and corner geometry, crisp asset rendering. Note that the native Claude fixture uses HEIC assets; a missing browser codec must not be disguised as a successful image parity run.
- Scroll-offset/restored selection geometry, source/reading modes, in-document find highlights, caret-reveal behavior. For captures, position the caret outside target text or hide the insertion point symmetrically; never change the actual live editing behavior just for the screenshot.

Measure heading rectangles, first glyph x/y, per-line baselines, line wraps, paragraph end, displayed list/checkbox dimensions. Edit and undo representative formatted notes before/after capture to ensure visuals are still source-backed. Compare both top and lower document states, including the native `let workspace = "native"` selection/reveal target.

**Gate 5:** Native and browser line wrapping/visible content match at the chosen viewport; heading and body bounding-box/baseline drift is documented and reduced to approximately 1–2 CSS pixels; named typography/Markdown ROIs pass the calibrated, *predeclared* pixel and geometric limits. Source round-trip, cursor correctness, undo isolation, read-only, autosave and long-note perf continue to pass.

## Stage 6 — Reproduce the approved transient *design targets* separately

The manifest at `~/d/tansu/design/transient-surfaces/manifest.json` is an intentional design oracle, with its own immutable SHA-256 values, focus-region rectangles and recommended `odiff` threshold **0.1 with antialiasing**. Its targets include search-result, empty-search, no-result, command-palette, recent notes, rename and modeless find scenes. They are **not necessarily currently rendered by Tansu's native production code**.

1. Build the browser surfaces to match target geometry and contents rather than repurposing current Tansu2 dashboard-style dialogs. Native transient code supplies 12pt rounded surfaces, shadow blur 18, shadow y=6, transparent 16pt component margins, muted blue-gray text, selected-row treatment, field sizes and placement. Resolve native colors accurately from the design specification.
2. Search full-window target is 900×640pt; panel geometry must follow its manifest and in-context specification, with the same selected note, query, result ordering and surrounding editor state. Match the background blur radius 5pt, scrim opacity 0.15, anchored panel bounds and list scrolling. Use actual DOM/CSS effects rather than full-window bitmap replacement. For modeless find, do **not** blur or move the document; preserve the native 36pt strip contract and the design manifest's outside-change-region rule if applicable.
3. Command/recent/rename compare their **transparent-margin component captures** at exact sizes, and separately compare their full-window in-context layouts against labeled design previews. A translucent blur layer may differ across AppKit CoreImage and CSS; record the difference, measure focus ROIs, and do not claim pixel-identical rendering without evidence.
4. Assert real keyboard navigation, escape/dismissal, focus restoration, no editor remount, stable selection, and click safety under overlays. Native behavior is part of the target, not just a picture.

**Gate 6:** Every design-target scene carries its approved target SHA, odiff full/focus percentages and separate `design-target` status. Geometry matches intended top/center positions and sizes. Unmatched targets remain explicitly red; do not substitute current native production screenshots or regenerate approved targets.

## Stage 7 — Convergence scoring and acceptance policy

Implement a repeatable feedback loop: capture -> hash/dimension checks -> geometry assertions -> odiff full/focus/region -> inspect top differences -> fix styling/DOM/decorations -> rerun -> record improvement. Keep artifacts from every major iteration, including first/last screenshots and side-by-side comparisons. Fix causes (font metrics, layout hierarchy, decorations) rather than adding per-scene CSS hacks.

Predeclare quantitative targets **before** tuning against the output. Suggested aspirational starting gates, to be calibrated against documented repeat-capture noise on the same macOS host:

- Exact screenshot dimensions, DPR=2, source/scene state verified: **mandatory pass**.
- Sidebar/tab/editor outer anchors: **±1 CSS point**; text baselines **±2 CSS points** at matched wraps; no unintended horizontal page overflow.
- Background-only/flat chrome ROIs: **≤1%** odiff changed pixels with threshold 0.1 + AA where the reference is stable.
- Empty/sparse shell scenes: **≤3%** whole-frame changed pixels as an initial target.
- Text-heavy/document or modal scenes: **≤6%** whole-frame changed pixels as a strong target; **≤10%** per text-heavy critical ROI as a preliminary bound, then tighten with actual repeatability data. Treat **≤2%** full-frame as a stretch target only if cross-render differences permit; never assume that a 1% *native-to-native* fixture limit transfers automatically to AppKit-to-WebKit.

These are **targets, not permission to weaken correctness**. If calibrated cross-render glyph rasterization proves a threshold impossible, document the measured floor and propose the smallest justified per-scene change in `docs/visual-parity-results.md` while keeping the gate red pending explicit approval. Do not silently relax percent/channel thresholds, blur reference, mask headings/images, or weight away failing focus ROIs. Report both `odiff --antialiasing` and raw comparisons.

For every pixel target also require semantic and geometric correctness; an image score alone can pass while a small but important control is missing. Keep native-current and design-target scores separate in the report. Rank outstanding mismatches by visual impact and user-facing importance, not solely by full-frame pixel area.

## Stage 8 — Integration and regression preservation

1. Run `make check`, `make test`, `make test-e2e` or their current equivalents in Tansu2, focused editor session/source/image/undo tests, plus `make bench` and (as practical) longer-session benchmark. Do not alter passkey enrollment, Rust storage, Tantivy, or HTTP contracts without a justified and separately tested compatibility fix.
2. Test on WebKit first and repeat desktop Chromium and Firefox smoke. Native pixel parity is calibrated for one pinned macOS/scale/browser combination; other engines should respect layout proportions/behavior but do not secretly share goldens when rasterization differs.
3. Capture 900×640, 1040×720, 520×720 native scenes exactly; extend desktop responsive checks to 1280×900 and 1440×900 as **browser-only** layout checks unless new native references are explicitly exported. Do not stretch a 900×640 golden to larger sizes.
4. Verify document source content, markdown links, pasted images, saved revisions, navigation and search overlays survive tab switching, scenario loading and toggling a transient surface. Capture only after rendering readiness; no flakiness hidden under arbitrary `waitForTimeout` or broad retries.
5. Where native capture is infeasible on CI, keep a separate **macOS 26/Retina visual acceptance job** with a documented runner assumption, and run browser-only unit/E2E/layout tests in ordinary CI. Do not let a CI runner lacking 2× native capture silently regenerate/approve oracle images.
6. `docs/visual-parity.md` must explain oracle provenance, scene identity, the source of each approved target, exact environment and commands, diff methodology, why 1% native-to-native is not a universal cross-render bound, and all known deviations. `docs/visual-parity-results.md` must include a per-scene matrix: oracle kind, dimensions, source hash, image hash, full/focus/ROI odiff score, geometry errors, pass/fail, before/after image paths, remaining issue and root cause.
7. Use no font-file distribution, screenshot-backed faux interface, native AppKit code embedded into the web runtime, expensive browser JS that reconstructs native bitmap pixels, or hacks that make test mode visually different from ordinary production aside from deterministic capture controls (caret/animation).

**Final acceptance:** on a supported native host, the run produces independently verified AppKit oracle exports and browser screenshots, all planned nondeferred native-current gates green, design-target gates either green or precisely documented as unmet, and preserved functional/performance tests. If a significant parity issue remains, continue work until exhausted by a real technical limit, then show it in the final report—not as an empty checkbox.

## Work habits and evidence requirements

- Work sequentially with explicit stages, committing **nothing**. A stage only passes with exact commands, logs, artifact locations and measured evidence. Do not rewrite baselines or run snapshot-update flags to force green.
- Use `odiff` for every canonical pair; produce cropped-ROI and full images. A missing visual comparison is **not** a successful test.
- Preserve production semantics. `~/d/tansu` may be edited in **test harness/tests/scripts/documentation only** to export native truth; Tansu2 may change UI markup, theme, CodeMirror decorations and parity tests. No changes to either demo/real vault.
- If sources changed while working, inspect and preserve them; avoid destructive reset/clean commands. Operate on fixture copies only.
- Prefer native visual consistency over a novel redesign. Do not add Solid, React, Effect, Tailwind or new visual libraries to this campaign unless an unavoidable objective requirement is demonstrated and documented.
- Keep a running `docs/visual-parity-results.md` with every stage/gate and a visual regression gallery. The final answer must include the actual run command, summary matrix (native-current pass/total, design-target pass/total), worst remaining ROI and diff percentage, exact before/after file paths, and known limitations. Never report “nearly identical” based on intuition alone.

## Kickoff instruction

> Execute this **Tansu2 Native Visual-Parity Campaign** against the current `~/d/tansu2` checkout. Use `~/d/tansu` as the authoritative existing native reference, extending its visual harness only in test-only files. Build the export, import, cross-render pixel-diff and geometry harness, and then iterate Tansu2 UI/decorations until the measurable desktop native-current and intended design-target scenes converge. Preserve native targets, raw Markdown, editor sessions, data safety, and the recent TS/tooling modernization. This is unattended, measurement-driven implementation work, not a proposal. Do not commit, push, deploy or alter real vaults. Keep failures and residual differences visible in the final report.
