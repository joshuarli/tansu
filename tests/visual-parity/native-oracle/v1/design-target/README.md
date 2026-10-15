# Tansu transient-surface fixture handoff — v1

This archive contains **seven replacement PNG design targets**, **three full-window context previews**, numeric design specifications, integrity/provenance metadata, a companion-note test-data update, and a coding-agent implementation prompt.

These are **native-rendered design targets, not screenshots of an implemented redesign and not proof of passing tests**. They were retrieved from the repository's `transient-design-output` GitHub Actions artifact and verified before packaging. They use AppKit attributed text and SF Symbols rather than regenerated image-model lettering. No fonts are distributed.

## Use

Give the coding agent this archive and `CODING_AGENT_PROMPT.md`. Extract into a separate working directory, verify `SHA256SUMS`, then copy **only the seven listed PNGs** into the same relative paths in the checkout. Do not delete the fixture directory, replace every file, or run snapshot-update flags to make the tests pass. The implementation must converge to these fixed targets.

The specification lives at `design/transient-surfaces/specification.json`; `manifest.json` maps every target to its test, original blob hash, dimensions, SHA-256, and required region-level comparison.

## Replacement inventory

| Target | Pixels | Capture contract |
| --- | --- | --- |
| `search-modal-baseline.png` | 1800 × 1280 | 900 × 640 pt full-window content; real Claude Code note |
| `vault-surface-search-empty.png` | 1800 × 1280 | Empty query; recorded `workspace` history |
| `vault-surface-search-no-results.png` | 1800 × 1280 | Query `quasar`; zero results |
| `vault-surface-command-palette.png` | 1040 × 768 | Transparent-margin component capture; no native utility titlebar |
| `vault-surface-recent-notes.png` | 1120 × 848 | Transparent-margin component capture; four ranked notes |
| `vault-surface-rename.png` | 840 × 376 | Transparent-margin component capture; selected `Studio Dashboard` title |
| `vault-surface-find.png` | 2080 × 1440 | Existing find strip restyled; document remains sharp and stationary |

All targets are 2× images. A 12-pt radius is 24 image pixels. Black surrounding a component in a viewer means transparent pixels, not a black app background.

## Correct note content

The current repository has **two different test corpora**. The rich search baseline and native chrome baseline use `Fixtures/ClaudeCodeNote/`. `NativeVaultSurfaceVisualTests` still uses Gallery, Project Atlas, Reading Queue, and Studio Dashboard. Accordingly, the search baseline now has the real Claude Code text and native editor backdrop; the other targets preserve their actual source-test states, rather than swapping every state to a different note.

The full-window command/recent previews use Gallery, which is selected by those tests. Rename and Find use Studio Dashboard. This is intentional, not an image-generation substitution.

The companion note in `design/transient-surfaces/test-data/Claude Search Notes.md` supplies real before/after context for the second result. Incorporate it into `makeSearchModalVault()`; do not hard-code the excerpt into product code. Do not change the frozen Claude Code note or its attachments.

## Preserve the editor

Nothing outside the allowlisted transient states is replaced. In particular, retain `vault-chrome-baseline.png`, normal tab/Markdown fixtures, lower-content fixtures, narrow/empty-vault fixtures, the note corpus, and Markdown rendering/configuration.

Modal blur and a faint scrim are intentional presentation effects over the real settled editor. They must not reflow, re-render, rewrite, or substitute its content. Find is modeless: no whole-window blur or scrim, and no new document movement. Its allowed change rectangle is `[440,124,1640,72]` pixels.

## Source and limits

Repository base: `f0311872da4e1301d8349016faeab254f514a696`.
Artifact: `transient-design-output`, ID `9959348735`, workflow run `33933442201`, workflow head `0a55112fda3043307b346782298211c87155d4b9`.
The design renderer is `scripts/render-transient-design-fixtures.swift` on the existing `design/transient-fixtures-2026-09-04` branch. It is a reference drawing tool, not production UI. Do not merge that entire branch merely to use these assets; inspect any unrelated changes first.

AppKit interaction behavior and production `odiff` parity have not been verified by this package. The implementation prompt explicitly requires that work, including real app captures, regional comparisons, and repeated passes. The previews are for composition/blur review, not a license to replace the app with screenshot layers.

## Integrity

From the extracted package root on macOS:

```sh
shasum -a 256 -c SHA256SUMS
```

`SHA256SUMS` covers every payload file except itself. `manifest.json` additionally records per-PNG dimensions and SHA-256, plus the original git blob identities for safe installation.
