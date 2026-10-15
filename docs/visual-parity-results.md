# Native visual parity results

## Final desktop run

Command: [desktop WebKit command](visual-parity.md)  
Run ID: `2026-10-15T13-08-44-852Z`  
Host: macOS 27.0, Aqua, arm64, 2× backing scale, Playwright WebKit 27.2  
Scope: 15 desktop scenes. The 520-point narrow scene is excluded by the desktop-only scope.

All 14 native-current comparisons pass. Four of seven approved design targets pass. Two of three in-context previews pass. All 15 captures have exact dimensions, verified fixture source hashes, and zero geometry errors. The final run returns nonzero because three design targets and the rename preview remain red.

The requested macOS 26 host was not available. The native and browser captures ran on macOS 27.0. The native repeat captures in the imported bundle differ by 0%. That does not establish a cross-renderer text noise limit.

The final [report](../.work/tmp/visual-parity/2026-10-15T13-08-44-852Z/report.json) and [image gallery](../.work/tmp/visual-parity/2026-10-15T13-08-44-852Z/index.html) include every actual, reference, diff, overlay, named crop, score, and geometry capture. Each linked `scene.json` records the source file hashes and actual screenshot SHA-256. The source and approved target manifests record their own hashes.

## Stage results

| Stage | Result | Evidence |
| --- | --- | --- |
| 0. Audit and baseline | Complete with host deviation | Tansu2 HEAD `316207d7c647bc64d0530356dc1ebbb4ddb386ab`. Tansu HEAD `4a1bd9b9cefc70c98e6724c0f8516d39cc64bb26`. macOS 27.0, Aqua, arm64, 2×. |
| 1. AppKit exporter | Complete | The existing native harness exports native-current captures and repeated images to an isolated directory. It did not update approved PNGs or native production code. |
| 2. Fixture corpus | Complete | Literal Markdown, original HEIC attachments, copied design targets, and fixture hashes are checked in under `tests/visual-parity/native-oracle/v1/`. |
| 3. Capture and comparison harness | Complete | Exact DPR 2 captures, source verification, geometry, AA and raw odiff results, and failure artifacts. `make visual-parity-fault-check` detected all six deliberate faults. |
| 4. Desktop shell geometry | Pass | All desktop geometry checks pass with zero errors. Sidebar, tabs, editor insets, modal bounds, and document overflow match their assertions. |
| 5. Markdown and editor surface | Pass at current native gates | Chrome, tabbed Markdown, lower Markdown, find, and search-result native-current scenes pass. The largest editor-content ROI is 6.81% AA in search results, below its 10% region limit. |
| 6. Approved transient targets | Partial | Search empty, search no-results, command palette, and recent notes pass. Search results, find full-frame, and rename remain red. |
| 7. Convergence gates | Red | All 14 native-current comparisons pass. Four of seven approved design targets pass. No thresholds, target images, or masks changed. |
| 8. Functional and performance regressions | Passed earlier in the campaign | `make check`, `make test`, Chromium, Firefox, and WebKit E2E, the fault check, and the benchmark runs passed before the final CSS alignment changes. They were not rerun after those changes. |

## Desktop scene scores

Scores are changed-pixel percentages from `odiff --threshold 0.1 --antialiasing`. The parenthesized value is the design focus ROI. Raw scores and every named ROI are in the linked scene record. `Source` names the literal fixture set. Each scene record contains its source hashes and actual PNG hash.

| Scene | Pixels | Source | Native-current AA | Approved target AA | Composition preview AA | Result and artifacts |
| --- | ---: | --- | ---: | ---: | ---: | --- |
| `chrome-900x640` | 1800×1280 | Claude Code | 5.03% | none | none | Pass. [Actual](../.work/tmp/visual-parity/2026-10-15T13-08-44-852Z/chrome-900x640/actual.png) · [scene record](../.work/tmp/visual-parity/2026-10-15T13-08-44-852Z/chrome-900x640/scene.json) |
| `tabs-markdown-1040x720` | 2080×1440 | Surface | 3.01% | none | none | Pass. [Actual](../.work/tmp/visual-parity/2026-10-15T13-08-44-852Z/tabs-markdown-1040x720/actual.png) · [scene record](../.work/tmp/visual-parity/2026-10-15T13-08-44-852Z/tabs-markdown-1040x720/scene.json) |
| `markdown-lower-1040x720` | 2080×1440 | Surface | 3.09% | none | none | Pass. [Actual](../.work/tmp/visual-parity/2026-10-15T13-08-44-852Z/markdown-lower-1040x720/actual.png) · [scene record](../.work/tmp/visual-parity/2026-10-15T13-08-44-852Z/markdown-lower-1040x720/scene.json) |
| `empty-900x640` | 1800×1280 | Empty | 0.02% | none | none | Pass. [Actual](../.work/tmp/visual-parity/2026-10-15T13-08-44-852Z/empty-900x640/actual.png) · [scene record](../.work/tmp/visual-parity/2026-10-15T13-08-44-852Z/empty-900x640/scene.json) |
| `find-1040x720` | 2080×1440 | Surface | 3.32% | none | none | Pass. [Actual](../.work/tmp/visual-parity/2026-10-15T13-08-44-852Z/find-1040x720/actual.png) · [scene record](../.work/tmp/visual-parity/2026-10-15T13-08-44-852Z/find-1040x720/scene.json) |
| `find-design-target-1040x720` | 2080×1440 | Surface | none | 3.32% (0.60%) | none | Red full image. Focus passes. [Actual](../.work/tmp/visual-parity/2026-10-15T13-08-44-852Z/find-design-target-1040x720/actual.png) · [scene record](../.work/tmp/visual-parity/2026-10-15T13-08-44-852Z/find-design-target-1040x720/scene.json) |
| `search-empty-900x640` | 1800×1280 | Surface | 0.21% | 0.38% (0.54%) | none | Pass. [Actual](../.work/tmp/visual-parity/2026-10-15T13-08-44-852Z/search-empty-900x640/actual.png) · [scene record](../.work/tmp/visual-parity/2026-10-15T13-08-44-852Z/search-empty-900x640/scene.json) |
| `search-no-results-900x640` | 1800×1280 | Surface | 0.32% | 0.48% (0.88%) | none | Pass. [Actual](../.work/tmp/visual-parity/2026-10-15T13-08-44-852Z/search-no-results-900x640/actual.png) · [scene record](../.work/tmp/visual-parity/2026-10-15T13-08-44-852Z/search-no-results-900x640/scene.json) |
| `search-results-900x640` | 1800×1280 | Claude Code | 4.83% | 5.10% (0.60%) | none | Native passes. Target full image is red. Focus passes. [Actual](../.work/tmp/visual-parity/2026-10-15T13-08-44-852Z/search-results-900x640/actual.png) · [scene record](../.work/tmp/visual-parity/2026-10-15T13-08-44-852Z/search-results-900x640/scene.json) |
| `command-palette-context-900x640` | 1800×1280 | Surface | 0.32% | none | 0.58% | Pass. [Actual](../.work/tmp/visual-parity/2026-10-15T13-08-44-852Z/command-palette-context-900x640/actual.png) · [scene record](../.work/tmp/visual-parity/2026-10-15T13-08-44-852Z/command-palette-context-900x640/scene.json) |
| `command-palette-panel` | 1040×768 | Surface | 0.35% | 0.53% (0.62%) | none | Pass. [Actual](../.work/tmp/visual-parity/2026-10-15T13-08-44-852Z/command-palette-panel/actual.png) · [scene record](../.work/tmp/visual-parity/2026-10-15T13-08-44-852Z/command-palette-panel/scene.json) |
| `recent-notes-context-900x640` | 1800×1280 | Surface | 0.28% | none | 0.69% | Pass. [Actual](../.work/tmp/visual-parity/2026-10-15T13-08-44-852Z/recent-notes-context-900x640/actual.png) · [scene record](../.work/tmp/visual-parity/2026-10-15T13-08-44-852Z/recent-notes-context-900x640/scene.json) |
| `recent-notes-panel` | 1120×848 | Surface | 0.50% | 0.81% (0.93%) | none | Pass. [Actual](../.work/tmp/visual-parity/2026-10-15T13-08-44-852Z/recent-notes-panel/actual.png) · [scene record](../.work/tmp/visual-parity/2026-10-15T13-08-44-852Z/recent-notes-panel/scene.json) |
| `rename-context-900x640` | 1800×1280 | Surface | 4.24% | none | 5.65% | Native passes. Composition preview is red. [Actual](../.work/tmp/visual-parity/2026-10-15T13-08-44-852Z/rename-context-900x640/actual.png) · [scene record](../.work/tmp/visual-parity/2026-10-15T13-08-44-852Z/rename-context-900x640/scene.json) |
| `rename-panel` | 840×376 | Surface | 1.88% | 1.59% (1.80%) | none | Native passes. Approved target is red. [Actual](../.work/tmp/visual-parity/2026-10-15T13-08-44-852Z/rename-panel/actual.png) · [scene record](../.work/tmp/visual-parity/2026-10-15T13-08-44-852Z/rename-panel/scene.json) |

## Before and after captures

These links compare the first campaign capture with the final desktop run. The recent-notes panel uses the first complete panel run because the initial baseline did not include that component scene.

| Scene | Before AA | Final AA | Before capture | Final capture |
| --- | ---: | ---: | --- | --- |
| Chrome | 17.89% | 5.03% | [Before](../.work/tmp/visual-parity/2026-10-15T01-41-26-640Z/chrome-900x640/actual.png) | [After](../.work/tmp/visual-parity/2026-10-15T13-08-44-852Z/chrome-900x640/actual.png) |
| Search empty | 19.95% | 0.21% | [Before](../.work/tmp/visual-parity/2026-10-15T01-41-26-640Z/search-empty-900x640/actual.png) | [After](../.work/tmp/visual-parity/2026-10-15T13-08-44-852Z/search-empty-900x640/actual.png) |
| Search results, native-current | 24.75% | 4.83% | [Before](../.work/tmp/visual-parity/2026-10-15T01-41-26-640Z/search-results-900x640/actual.png) | [After](../.work/tmp/visual-parity/2026-10-15T13-08-44-852Z/search-results-900x640/actual.png) |
| Command palette panel, design target | 2.96% | 0.53% | [Before](../.work/tmp/visual-parity/2026-10-15T01-41-26-640Z/command-palette-panel/actual.png) | [After](../.work/tmp/visual-parity/2026-10-15T13-08-44-852Z/command-palette-panel/actual.png) |
| Recent notes panel, design target | 2.48% | 0.81% | [Before](../.work/tmp/visual-parity/2026-10-15T04-13-45-399Z/recent-notes-panel/actual.png) | [After](../.work/tmp/visual-parity/2026-10-15T13-08-44-852Z/recent-notes-panel/actual.png) |
| Rename panel, design target | 7.68% | 1.59% | [Before](../.work/tmp/visual-parity/2026-10-15T01-41-26-640Z/rename-panel/actual.png) | [After](../.work/tmp/visual-parity/2026-10-15T13-08-44-852Z/rename-panel/actual.png) |
| Find design focus ROI | 2.29% | 0.60% | [Before](../.work/tmp/visual-parity/2026-10-15T01-41-26-640Z/find-design-target-1040x720/comparisons/design-target/score.json) | [After](../.work/tmp/visual-parity/2026-10-15T13-08-44-852Z/find-design-target-1040x720/comparisons/design-target/score.json) |

## Remaining differences

- Search results pass the 6% native-current full-frame gate at 4.83%. The approved design target scores 5.10% full-frame and 0.60% in its focus region. Most of the remaining full-frame difference lies outside the panel, where AppKit and WebKit render the document, blur, and scrim differently.
- Find passes native-current at 3.32%. The design target scores 3.32% full-frame and 0.60% in its focus region. The find controls match. The full-frame delta is in the unchanged document area, where AppKit and WebKit text pixels differ.
- Rename passes native-current at 1.88%. Its approved target is 1.59% full-frame and 1.80% in the focus region, above the 1% limits. Panel and control geometry pass. The remaining visible diff is concentrated on text and control edges. The target uses AppKit text drawing. Tansu2 uses WebKit.
- The rename in-context preview scores 5.65%. It is a composition reference, not an approved design target. The command and recent-notes previews pass at 0.58% and 0.69%.
- macOS 26 was unavailable. The measured run used macOS 27.0, so the requested host-specific acceptance remains unverified.

The campaign did not change comparison limits, edit approved PNGs, add masks, or substitute screenshots for UI. The native exporter and standalone fixture corpus remain separate from user vaults. No production Tansu code changed.

## Verification

- Final desktop capture: `make visual-parity` with the scene list in [visual-parity.md](visual-parity.md). It captures all 15 desktop scenes and exits nonzero for the red gates above.
- Final report: `make visual-parity-report RUN_ID=2026-10-15T13-08-44-852Z`. It prints dimensions, actual PNG SHA-256, AA and raw scores, focus ROIs, and gallery location.
- `make visual-parity-fault-check` passed its six deliberate failure cases earlier in the campaign.
- `make check`, `make test`, `make test-e2e-chromium`, `make test-e2e-firefox`, and `make test-e2e-webkit` passed earlier in the campaign. These were not rerun after the final CSS alignment changes.
- `make bench` and `make bench-long-session` passed earlier in the campaign. The performance gate was ready before and after the timed run. These were not rerun after the final CSS alignment changes.
