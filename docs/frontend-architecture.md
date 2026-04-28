# Frontend Architecture

This note describes the current intended ownership boundaries in `web/ts/`.

## Layers

### App shell

- `main.tsx` mounts the app.
- `app.tsx` composes the visible shell and top-level overlays.
- `app-boot.ts` owns startup and unlock orchestration:
  - browser capability gating through `bootstrap.ts`
  - locked-vault unlock flow
  - deferred `initApp()` on first successful startup
  - opening local storage, restoring session state, and starting `serverStore`
- `app-commands.ts` owns command registration and global app key handling.
- `app-runtime.ts` owns runtime wiring that connects top-level app services:
  - wiki-link navigation/open-or-create behavior
  - `serverStore` configuration against the active editor/session
- `bootstrap.ts` contains boot-only helpers:
  - browser feature checks
  - unsupported-browser rendering
  - unlock-screen rendering
  - app start / locked-vault bootstrap flow
  - generic SSE reconnect primitives used by `server-store.ts`

`app.tsx` should stay focused on composition and light top-level lifecycle wiring.
`bootstrap.ts` should not own ordinary in-app UI state such as notifications or status banners.

### UI state

- `ui-store.ts` owns transient app UI state:
  - search open/closed
  - palette open/closed
  - settings open/closed
  - notification banner state
  - server-status banner text

`uiStore` is presentation-oriented state. It should not own note/session persistence or SSE lifecycle.

### Tab/session state

- `tab-state.ts` owns open tabs, active tab index, closed-tab stack, cursor positions, and tab state transitions.
- `tab-state-storage.ts` owns note/session persistence concerns:
  - fetch note with offline fallback
  - persist session state
  - restore session state
  - sync cached session state to the server
  - cache note snapshots for offline use
- `tab-actions.ts` owns UI-facing tab actions that coordinate state, API calls, notifications, and invalidation:
  - create note and open it
  - surface note-creation failures to the user

The boundary is improved but not final yet:

- `tab-state.ts` is no longer responsible for note-creation UX
- more UI-facing actions may still be worth moving out over time if the module grows again

Future refactors should keep pushing toward:

- pure tab/session state
- persistence and offline I/O
- UI-facing actions

### Server lifecycle

- `server-store.ts` owns:
  - SSE connection lifecycle
  - reconnect backoff
  - server-availability status updates
  - fanout of file/pinned/vault invalidation signals

`serverStore` may notify the UI about connectivity and externally deleted active notes, but it should stay focused on server lifecycle and invalidation, not general application logic.

### Editor bridge

- `packages/md-wysiwyg` is the editor engine.
- `editor-adapter.ts` is the narrow app-facing wrapper around that engine.
- `editor.ts` is the integration layer that connects the editor engine to:
  - tab state
  - save/reload flow
  - tag/frontmatter sync
  - backlinks/revisions/autocomplete side features

The editor engine remains imperative and framework-neutral on purpose. The app should keep imperative DOM concentrated at this boundary and not spread it across ordinary UI code.

The ownership split inside the editor boundary is now:

- `packages/md-wysiwyg` owns editing behavior:
  - contenteditable DOM behavior
  - markdown rendering/serialization
  - selection/cursor preservation
  - undo/redo mechanics
  - block/inline editing transforms
- `web/ts/editor.ts` owns app integration:
  - active note/session wiring
  - save/reload and conflict handling
  - frontmatter/tag synchronization
  - revisions/backlinks shell coordination
  - applying app-level editor preferences to the live editor instance

`editor.ts` should stay a coordinator around the editor package, not a second editor engine.

## Current module-level singletons

These are intentional today, but they are also the main places where ownership is implicit:

- `uiStore`
- `serverStore`
- `tabsStore`
- `input-dialog.tsx` active dialog state
- `revisions.tsx` current open revisions host/path

When adding new stateful modules, prefer asking first whether the state belongs in one of the existing owners above before creating another singleton.

Current rule for app state containers:

- keep small, explicit stores when the ownership is obvious (`uiStore`, `serverStore`, `tabsStore`)
- prefer passing explicit dependencies into composition layers before introducing another global store
- only introduce a broader service container if multiple new cross-cutting services start needing the same lifecycle and dependency wiring

## Overlay and panel patterns

- `search.tsx`, `settings.tsx`, `palette.tsx`, and `input-dialog.tsx` are ordinary app overlays and should stay under the main app tree.
- `overlay.tsx` is the shared primitive for those overlays:
  - backdrop click closes
  - focus is restored by the caller via `createFocusRestorer()`
  - close behavior is explicit through `onClose`
- `input-dialog.tsx` no longer owns its own mini-root. The host is rendered by `app.tsx`, and callers only invoke `showInputDialog(...)`.

The remaining imperative surfaces are deliberate:

- `context-menu.tsx` still mounts a temporary body-level root because it is ephemeral, position-based UI that needs to escape local stacking and clipping contexts.
- `revisions.tsx` still mounts into an editor-owned host because it is tied to the active editor session, revision preview state, and restore flow.
- `backlinks.tsx` still renders directly into an editor-owned host because it is a lightweight editor-adjacent view refreshed as notes change.

Those modules should stay small and specialized. If they grow into broader app-owned workflows, move them under the main tree instead of creating more free-floating roots.

## Practical rule

Use Solid components and signals for ordinary app UI.

Use imperative DOM only when the browser integration is inherently imperative, such as:

- `contenteditable` editing
- selection/range preservation
- clipboard/image paste
- SSE connection lifecycle
- WebAuthn/browser capability boundaries

Use a small imperative mount when the UI is truly host-bound or body-positioned, such as:

- context menus
- editor-owned side panels
- integration surfaces that must attach to DOM owned by another subsystem

## Choosing Solid vs imperative DOM

Prefer Solid when:

- the UI is ordinary application chrome or workflow
- state is app-owned and benefits from explicit reactive dependencies
- lifecycle should follow the main app tree
- accessibility, focus management, and dismissal behavior should be standardized across overlays

Prefer imperative DOM when:

- the browser API is inherently imperative, especially `contenteditable`
- selection/range state is part of the feature, not incidental implementation detail
- the UI must attach to a host owned by another subsystem
- body-level positioning or clipping escape is the primary reason the UI exists

When in doubt, choose the simpler model that keeps ownership obvious. The default should be Solid components. Imperative DOM should be a deliberate exception with a concrete browser or host-bound reason.
