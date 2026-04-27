# Frontend SolidJS Migration Plan

This plan tracks the migration from imperative DOM modules in `web/` to JSX and
SolidJS. The migration is intentionally test-first: build characterization tests
around existing behavior, then convert one UI island at a time behind those
tests.

## Goals

- [ ] Move app UI from scattered `document.querySelector`, `document.createElement`, and module-level DOM mutation to typed SolidJS components.
- [ ] Keep the app lightweight: SolidJS only, no router, no global state library, no CSS framework, no Vite migration unless separately justified.
- [ ] Preserve current app behavior during migration.
- [ ] Keep the editor's `contenteditable` surface stable by treating it as an imperative island until the surrounding shell is declarative.
- [ ] Keep `packages/md-wysiwyg` framework-neutral at its core, with optional SolidJS adapters only if useful.
- [ ] Improve production readiness through stronger tests, explicit async states, cleanup discipline, and accessibility fixes.

## Characterization Tests To Add Before Conversion

### App Bootstrap And Global Lifecycle

- [x] Add test coverage for unlocked startup initializing the main app shell.
- [x] Add test coverage for locked startup hiding `#app` and showing unlock screen.
- [x] Add test coverage for recovery-key unlock success removing unlock screen and starting the app.
- [x] Add test coverage for recovery-key unlock failure showing an error and re-enabling the submit button.
- [x] Add test coverage for biometric unlock auto-trigger when PRF is available.
- [x] Add test coverage for biometric unlock failure message.
- [x] Add test coverage for unsupported browser feature page.
- [x] Add test coverage for notification show, auto-dismiss, and click-dismiss behavior.
- [x] Add test coverage for server status show/hide during SSE reconnect.
- [x] Add test coverage for pagehide/beforeunload closing SSE.
- [x] Add test coverage for focus/visibility reconnect behavior.

### Tabs

- [x] Existing tests cover rendering, active state, dirty dot, close button, context menu, tooltip, space-to-close, middle click, new-note dialog, and rename event.
- [x] Add explicit test that clicking a non-active tab switches active tab.
- [x] Add explicit test that the close button does not also switch the tab.
- [x] Add explicit test that tooltip position updates from tab bounds.
- [x] Add explicit test that active tab scrolls into view.
- [x] Add explicit test that space does not close when focus is in an input or textarea.
- [x] Add explicit test that unpin context menu label appears for pinned tabs.

### File Navigation

- [x] Existing tests cover active state under rapid events, collapse button, search mode, empty/error states, context menu, pin/delete/rename actions, and pinned refresh.
- [x] Add explicit test for pinned file de-duplication against recent files.
- [x] Add explicit test for opening a note by clicking a nav item.
- [x] Add explicit test for unpin action when file is already pinned.
- [x] Add explicit test for stale search responses not replacing newer results.
- [x] Add explicit test that active state updates when `tab:change` fires without `files:changed`.

### Search Modal

- [x] Existing tests cover open/close/toggle, scoped placeholder, escape/backdrop close, rendering results, tags, score breakdown, create note, API error, settings failure, and stale response ordering.
- [x] Add explicit test that scoped search sends `path` and suppresses create-note option.
- [x] Add explicit test that stale response from an old scope is ignored.
- [x] Add explicit test that `show_score_breakdown: false` hides score details.
- [x] Add explicit test that click selection updates selected index before opening.
- [x] Add explicit test that ArrowDown wraps from last item to first.
- [x] Add explicit test that ArrowUp wraps from first item to last.
- [x] Add explicit test that Enter on the create option creates the note.
- [x] Convert `search.ts` to `SearchModal.tsx`.
- [x] Preserve temporary open/close/toggle imperative control surface.
- [x] Keep stale request guard behavior.
- [x] Keep scoped search behavior.

### Command Palette

- [x] Existing tests cover lifecycle, filtering, click, keyboard navigation, Enter, Escape, and `matchesKey`.
- [x] Add explicit test that selected index resets on open.
- [x] Add explicit test that selected index clamps when filtering reduces result count.
- [x] Add explicit test that backdrop click closes.
- [x] Add explicit test that empty filter result renders no command items.
- [x] Add explicit test that command action errors do not leave inconsistent UI, if this behavior is desired.
- [x] Convert `palette.ts` to `CommandPalette.tsx`.
- [x] Move command registration to app-level state.

### Settings Modal

- [x] Existing tests cover load, save, defaults on error, slider display, excluded-folder Enter save, encrypted security rendering, lock button, save failure, lifecycle, toggle, and backdrop close.
- [x] Add explicit test that cancel closes without saving.
- [x] Add explicit test that save sends the exact settings payload.
- [x] Add explicit test for excluded folder trimming and empty entry removal.
- [x] Add explicit test for PRF remove action.
- [x] Add explicit test for PRF register success.
- [x] Add explicit test for PRF register failure.
- [x] Add explicit test for status failure hiding/degrading the security section.
- [x] Convert `settings.ts` to `SettingsModal.tsx`.
- [x] Load settings on open.
- [x] Use typed form state.
- [x] Save exact API shape.
- [x] Keep PRF controls separate in the modal render path.

### Input Dialog

- [x] Add test for opening with placeholder text.
- [x] Add test for Enter resolving trimmed value.
- [x] Add test for Enter with empty value resolving `null` or no-op, matching current behavior.
- [x] Add test for Escape resolving `null`.
- [x] Add test for backdrop click resolving `null`.
- [x] Add test for cleanup of event listeners after close.

### Context Menu

- [x] Add test for positioning at click coordinates.
- [ ] Add test for disabled item behavior if supported.
- [x] Add test for danger class rendering.
- [x] Add test for outside click cleanup.
- [x] Add test for deferred action behavior.

### Editor Shell

- [x] Existing tests cover rendering markdown, frontmatter hiding/source preservation, toolbar/source/menu creation, tag row, markdown serialization, cursor restoration, hide behavior, save classification, and reload classification.
- [x] Add explicit test for source-mode edit syncing back to rendered mode.
- [x] Add explicit test for tag add via autocomplete callback path.
- [x] Add explicit test for tag remove syncing source frontmatter.
- [x] Add explicit test for Backspace removing last tag from empty tag input.
- [x] Add explicit test for toolbar format button wiring.
- [x] Add explicit test for more-menu actions: revisions, backlinks, source mode, or available current items.
- [x] Add explicit test for conflict banner action integration.
- [x] Add explicit test for autosave timer scheduling and cancellation.
- [x] Add explicit test that autosave defers while a non-collapsed selection is active.
- [x] Add explicit test for undo/redo keyboard behavior.
- [x] Add explicit test for source-mode save path.
- [x] Add explicit test for paste image handler integration.

### Renderer And Markdown Ownership

- [x] Existing enforcement test prevents direct render function imports outside `renderer.ts`.
- [x] Add enforcement test for markdown `innerHTML` writes remaining centralized.
- [x] Add enforcement test for converted modules not using app-root ID queries.
- [x] Add enforcement test for no broad `document.body.innerHTML` outside known bootstrap/test exceptions.
- [x] Add enforcement test for no direct `renderMarkdown*` calls from SolidJS components except approved adapter boundaries.

### `packages/md-wysiwyg`

- [x] Existing package tests cover markdown render, serialization, cursor offset, selection rendering, transforms, inline transforms, diff, merge, highlight, roundtrip, and utilities.
- [x] Add tests for any optional SolidJS entrypoint before adding it.
- [x] Add `MarkdownPreview` tests if introduced.
- [x] Add `MarkdownEditorSurface` tests if introduced.
- [x] Add `DiffView` component tests if introduced.
- [x] Add tests proving the core package remains usable without SolidJS adapters.

## SolidJS Setup

- [x] Add `solid-js` as the only production frontend dependency.
- [x] Update `package.json` bundle script to compile `web/ts/main.tsx`.
- [x] Add SolidJS-compatible JSX build settings and any minimal required build plugin/runtime glue.
- [x] Update `tsconfig.json` for SolidJS TSX compilation.
- [x] Ensure `vitest.config.ts` coverage includes `web/ts/**/*.tsx`.
- [x] Ensure oxlint/oxfmt cover `.tsx` files.
- [x] Add `web/ts/component-test-helper.tsx`.
- [x] Add a minimal smoke component test.
- [x] Confirm production bundle succeeds.
- [x] Confirm dev bundle succeeds.

## App Shell Conversion

- [x] Create `web/ts/main.tsx` as a thin SolidJS mount.
- [x] Create `web/ts/app.tsx`.
- [x] Render the existing static shell in JSX using the same IDs/classes.
- [x] Keep legacy init functions running from a single SolidJS mount/init boundary.
- [x] Keep `web/index.html` as only the root mount and script/style links.
- [x] Verify old modules still work against the JSX-rendered shell.
- [x] Remove duplicated static app shell from `web/index.html`.
- [x] Add tests for shell render.
- [x] Run full frontend tests and e2e smoke.

## Leaf Component Conversions

### Context Menu

- [x] Create `ContextMenu.tsx`.
- [x] Preserve temporary imperative `showContextMenu(items, x, y)` API.
- [x] Render menu items declaratively.
- [x] Add cleanup on outside click.
- [x] Keep keyboard/accessibility improvements scoped and tested.
- [x] Delete old imperative DOM construction after callers pass tests.

### Input Dialog

- [x] Create `InputDialog.tsx`.
- [x] Preserve temporary `showInputDialog()` Promise API.
- [x] Render dialog declaratively.
- [x] Add focus management.
- [x] Add Escape/backdrop cleanup.
- [x] Delete old imperative DOM construction after callers pass tests.

### Conflict Banner

- [x] Create `ConflictBanner.tsx`.
- [x] Convert keep-mine/take-theirs callbacks to props.
- [x] Preserve current conflict behavior.
- [x] Add integration test from editor reload/save conflict paths.

### Backlinks

- [x] Create `Backlinks.tsx`.
- [x] Render loading, empty, error, and list states.
- [x] Keep `openTab` callback explicit.
- [x] Remove direct DOM writes from `backlinks.ts`.

### Revisions

- [x] Create `RevisionsPanel.tsx`.
- [x] Render loading, empty, error, list, diff preview, and restore states.
- [x] Keep restore event compatibility until editor is converted.
- [x] Remove direct DOM writes from `revisions.ts`.

### Vault Switcher

- [x] Create `VaultSwitcher.tsx`.
- [x] Render select and empty states declaratively.
- [x] Preserve current API behavior.
- [x] Ensure vault switch refresh and SSE behavior remain covered.

## State Ownership Migration

- [x] Add a subscription API to `tab-state.ts` if needed by SolidJS hooks/signals.
- [x] Add `useTabs()` hook.
- [x] Convert `tabs.ts` to `TabBar.tsx`.
- [x] Move tooltip state into `TabBar`.
- [x] Move global space-to-close listener into a cleanup-safe effect.
- [x] Convert `filenav.ts` to `FileNav.tsx`.
- [x] Move file-nav loading/error/search state into component state.
- [x] Convert notification pill to component state.
- [x] Convert server status to component state.
- [x] Give SSE lifecycle one owner.
- [x] Replace broad event-bus usage with props/state where practical.
- [x] Keep typed event bus only where it remains the simplest integration boundary.

## Modal Conversion

- [x] Convert `search.ts` to `SearchModal.tsx`.
- [x] Preserve temporary open/close/toggle imperative control surface.
- [x] Keep stale request guard behavior.
- [x] Keep scoped search behavior.
- [x] Convert `palette.ts` to `CommandPalette.tsx`.
- [x] Move command registration to app-level state.
- [x] Move global shortcut handling to one cleanup-safe effect.
- [x] Convert `settings.ts` to `SettingsModal.tsx`.
- [ ] Split security controls into a small component if helpful.
- [x] Keep exact API payload shapes.

## Editor Conversion

- [x] Create `EditorShell.tsx`.
- [x] Keep `contenteditable` as an imperative island via refs.
- [x] Move toolbar rendering into JSX.
- [x] Move tag row rendering into JSX.
- [x] Move source toggle rendering into JSX.
- [x] Move more-menu trigger rendering into JSX.
- [x] Keep markdown rendering through `renderer.ts`.
- [x] Keep `domToMarkdown` serialization path unchanged.
- [x] Preserve custom undo/redo behavior.
- [x] Preserve source-text format operations.
- [x] Preserve autosave debounce and conflict handling.
- [x] Preserve cursor and selection sentinels.
- [x] Convert editor event listeners into cleanup-safe effects.
- [ ] Extract editor controller logic only where it lowers risk.
- [ ] Run editor unit tests after every editor slice.
- [x] Run e2e editor/save/transform/fuzz/firefox tests before considering this phase complete.

## `packages/md-wysiwyg` SolidJS Adapter

- [x] Keep core package framework-neutral.
- [x] Add optional `./solid` export only if app conversion benefits from it.
- [x] Add `src/solid.tsx` only after tests specify expected adapter behavior.
- [x] Add `MarkdownPreview` if useful.
- [x] Add `MarkdownEditorSurface` only if it does not hide app-specific editor logic.
- [x] Add `DiffView` if revision UI benefits from it.
- [x] Ensure package core tests do not require SolidJS.
- [x] Ensure app can still import core package APIs from `@joshuarli98/md-wysiwyg`.

## CSS And Accessibility Hardening

- [x] Keep `web/static/style.css` initially.
- [x] Organize CSS by component sections.
- [x] Prefer class selectors over ID selectors for styling.
- [x] Keep stable IDs only while legacy modules or e2e selectors require them.
- [x] Add accessible modal roles.
- [x] Add `aria-modal` to modal dialogs.
- [x] Add labels or accessible names to inputs/buttons.
- [x] Replace clickable `div`/`span` controls with real buttons where possible.
- [x] Add focus restore for modals.
- [x] Add `aria-live` for notification/status behavior.
- [x] Add keyboard coverage for converted components.

## Production Readiness

- [x] Add app-level error boundary.
- [x] Centralize JSON parsing and typed API boundaries.
- [x] Make loading/empty/error states explicit in converted components.
- [x] Ensure every document/window listener has cleanup.
- [x] Ensure every timer has cleanup.
- [x] Ensure SSE reconnect timers are owned and cleaned.
- [x] Ensure overlays/popovers clean up on unmount.
- [x] Avoid compatibility layers unless explicitly justified.
- [x] Add final enforcement tests for post-migration DOM restrictions.

## Final Migration Completion Criteria

- [x] `web/ts/main.tsx` is the only app bootstrap entrypoint.
- [x] App shell is rendered by SolidJS.
- [x] Tabs, file nav, search, palette, settings, input dialog, context menu, notification, server status, and vault switcher are SolidJS components.
- [x] Editor shell is SolidJS, with the editable surface isolated behind refs.
- [x] `renderer.ts` remains the only app markdown render sink.
- [x] No converted component relies on fixed app-root `document.querySelector` lookups.
- [x] No unowned global listeners are registered at module import time.
- [x] Existing unit tests pass.
- [x] Existing package tests pass.
- [x] Existing Rust tests pass.
- [x] Existing e2e tests pass.
- [x] New migration characterization tests pass.
- [x] Bundle succeeds in dev and production modes.
