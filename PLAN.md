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

## Non-Goals For The Initial Migration

- [ ] Do not redesign the app visually during the conversion.
- [ ] Do not replace the Rust server or API shape.
- [ ] Do not introduce a client router.
- [ ] Do not introduce Redux, Zustand, Jotai, signals, or another state library.
- [ ] Do not make the editor fully controlled on every keystroke.
- [ ] Do not move app-specific behavior into `packages/md-wysiwyg`.
- [ ] Do not add a CSS framework.

## Baseline Gates

- [x] Record current `tsgo --noEmit` result. Passed.
- [x] Record current `tsgo -p packages/md-wysiwyg/tsconfig.json --noEmit` result. Passed.
- [x] Record current `vitest run` result. Passed: 29 files, 403 tests after adding bootstrap/global lifecycle coverage and the Solid shell render test.
- [x] Record current `cd packages/md-wysiwyg && vitest run` result. Passed via `pnpm exec vitest run`: 11 files, 394 tests.
- [x] Record current `cargo test` result. Passed: 126 Rust tests across lib/bin targets.
- [x] Record current `pnpm run test-e2e` result, or document blocker if the local binary/browser setup is not ready. Passed: 10 files, 37 tests. Harness now starts the server with a temp vault config and Playwright browsers are installed.
- [x] Confirm `pnpm run bundle` succeeds before any SolidJS changes. Passed.
- [x] Confirm `pnpm run bundle-dev` succeeds before any SolidJS changes. Passed.

## Pre-Migration Test Inventory

- [x] Inventory existing DOM unit tests in `web/ts/*.test.ts`.
      Current DOM/unit coverage includes `api`, `autocomplete`, `backlinks`, `bootstrap`, `conflict`, `context-menu`, `editor`, `filenav`, `format-toolbar`, `image-paste`, `image-resize`, `input-dialog`, `link-hover`, `offline`, `palette`, `renderer`, `revisions`, `search`, `settings`, `tabs`, `tag-autocomplete`, `webauthn`, `wikilinks`, and supporting pure modules.
- [x] Inventory existing browser e2e tests in `web/ts/e2e/*.test.ts`.
      Current browser coverage includes `autocomplete`, `editor`, `firefox-regressions`, `fuzz-editor`, `new-file-save`, `save`, `shortcuts`, `sse-stability`, `tabs`, and `transforms`.
- [x] Identify modules with module-level DOM side effects.
      Current module-import DOM work exists in `bootstrap.ts`, `context-menu.ts`, `format-toolbar.ts`, `link-hover.ts`, `tabs.ts`, `tag-autocomplete.ts`, and `legacy-main.ts`.
- [x] Identify modules that own global listeners.
      Current document/window/global listener owners include `autocomplete.ts`, `bootstrap.ts`, `editor.ts`, `format-toolbar.ts`, `image-resize.ts`, `input-dialog.ts`, `legacy-main.ts`, `link-hover.ts`, `palette.ts`, `search.ts`, `settings.ts`, `tabs.ts`, `tag-autocomplete.ts`, and `wikilinks.ts`.
- [x] Identify modules that own timers.
      Current timer owners include `bootstrap.ts`, `context-menu.ts`, `editor.ts`, `legacy-main.ts`, and `link-hover.ts`.
- [x] Identify modules that own async request cancellation or stale-response guards.
      Current stale-request / cancellation-sensitive modules are `search.ts` and `filenav.ts`.
- [x] Identify modules that write `innerHTML`.
      Markdown/content writers remain `renderer.ts`; other UI HTML writers currently include `bootstrap.ts`, `editor.ts`, `filenav.ts`, `format-toolbar.ts`, `palette.ts`, `revisions.ts`, `search.ts`, `settings.ts`, `tabs.ts`, and `vault-switcher.ts`.
- [x] Identify modules that call `document.body.append`.
      Current body-append owners are `autocomplete.ts`, `context-menu.ts`, `format-toolbar.ts`, `image-resize.ts`, `link-hover.ts`, `tabs.ts`, and `tag-autocomplete.ts`.

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
- [ ] Add tests for any optional SolidJS entrypoint before adding it.
- [ ] Add `MarkdownPreview` tests if introduced.
- [ ] Add `MarkdownEditorSurface` tests if introduced.
- [ ] Add `DiffView` component tests if introduced.
- [ ] Add tests proving the core package remains usable without SolidJS adapters.

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

- [ ] Keep core package framework-neutral.
- [ ] Add optional `./solid` export only if app conversion benefits from it.
- [ ] Add `src/solid.tsx` only after tests specify expected adapter behavior.
- [ ] Add `MarkdownPreview` if useful.
- [ ] Add `MarkdownEditorSurface` only if it does not hide app-specific editor logic.
- [ ] Add `DiffView` if revision UI benefits from it.
- [ ] Ensure package core tests do not require SolidJS.
- [ ] Ensure app can still import core package APIs from `@joshuarli98/md-wysiwyg`.

## CSS And Accessibility Hardening

- [x] Keep `web/static/style.css` initially.
- [x] Organize CSS by component sections.
- [ ] Prefer class selectors over ID selectors for styling.
- [ ] Keep stable IDs only while legacy modules or e2e selectors require them.
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

- [ ] `web/ts/main.tsx` is the only app bootstrap entrypoint.
- [ ] App shell is rendered by SolidJS.
- [ ] Tabs, file nav, search, palette, settings, input dialog, context menu, notification, server status, and vault switcher are SolidJS components.
- [ ] Editor shell is SolidJS, with the editable surface isolated behind refs.
- [ ] `renderer.ts` remains the only app markdown render sink.
- [ ] No converted component relies on fixed app-root `document.querySelector` lookups.
- [ ] No unowned global listeners are registered at module import time.
- [ ] Existing unit tests pass.
- [ ] Existing package tests pass.
- [ ] Existing Rust tests pass.
- [ ] Existing e2e tests pass.
- [ ] New migration characterization tests pass.
- [ ] Bundle succeeds in dev and production modes.
