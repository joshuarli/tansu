# Frontend SolidJS Refactor Plan

Goal: move `web/ts` from a well-tested controller-style app to a more declarative, store-driven Solid app without destabilizing the editor.

## Phase 0: Guardrails

- [ ] Keep `tsgo --noEmit` and targeted `vitest` green after each pass.
- [ ] Keep architecture invariant tests current as ownership boundaries move.
- [ ] Track the main dependency hubs (`app.tsx`, `editor.ts`, `tab-state.ts`) and avoid making them fatter during refactors.

## Phase 1: Remove Framework Bypasses

- [x] Replace `settings.tsx` DOM scraping with reactive draft state as the save source of truth.
- [x] Replace local `document.querySelector(...)` lookups with owned refs where the element already lives inside the component/controller.
- [x] Reduce stringly `innerHTML` UI assembly where the UI structure is persistent.
- [x] Add a single error-reporting path for user-important silent catches.

## Phase 2: Make App Ownership Declarative

- [ ] Make `App` own the mounted UI tree for search, palette, settings, file nav, and editor shell.
- [ ] Convert feature-local `render()` controllers into mounted components plus thin imperative adapters only where needed.
- [ ] Remove leftover double-entry patterns such as “component export + separate mount/init helper” when one ownership path is enough.

## Phase 3: Introduce Explicit App Stores

- [ ] Introduce a tabs/session store with a clear API and move module-level mutable state behind it.
- [ ] Introduce a UI store for overlays, notifications, and command/search/settings visibility.
- [ ] Introduce an SSE/server-connection store so reconnect logic is not owned by `App`.
- [ ] Replace event-bus flows with explicit store/context flows where the producer and consumer are in the same domain.

## Phase 4: Break Up Editor Orchestration

- [ ] Split `editor.ts` into editor session, autosave/conflict handling, tag/frontmatter handling, and shell wiring.
- [ ] Keep pure decision helpers pure and move more branching out of DOM/event handlers.
- [ ] Define a narrow adapter boundary around `@joshuarli98/md-wysiwyg` so editor integration is easier to reason about and test.

## Phase 5: Shared UI Primitives

- [x] Extract shared modal/listbox primitives used by search, palette, settings, and input dialog.
- [x] Normalize focus restore, keyboard navigation, and scroll-to-selection behavior across overlays.
- [x] Remove duplicated rename/pin/delete action wiring across tabs and file nav.

## Phase 6: Hardening

- [x] Add architectural tests for broad app-root DOM queries and controller self-mount patterns.
- [x] Add tests for explicit user-visible error handling in save/rename/create flows.
- [x] Re-evaluate remaining `innerHTML` exceptions and keep only the ones that are structurally justified.

## Completed Passes

- [x] Rewrite `settings.tsx` so save uses reactive state instead of scraping the rendered DOM.
- [x] Replace list-scroll `querySelector` lookups in `search.tsx` and `palette.tsx` with owned refs.
- [x] Update tests to reflect event-driven state instead of relying on DOM mutation without input/change events.
- [x] Add shared action-error reporting and cover it in tabs, file nav, and settings tests.
- [x] Move controller root ownership into `App` and test setup instead of self-discovery from feature modules.
- [x] Replace unlock-screen HTML string assembly with explicit DOM construction and keep only justified `innerHTML` uses.
- [x] Extract shared overlay focus restoration and shared listbox selection helpers.
