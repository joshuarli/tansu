# TODO

## Code quality audit

### Critical

- [ ] **XSS: `search.ts:145`** — `excerpt.innerHTML = r.excerpt` injects server HTML directly, bypassing the `setHTML`/Sanitizer API invariant used everywhere else. Fix: use `excerpt.setHTML(r.excerpt)` or build the excerpt by wrapping match text in `<b>` text nodes.

- [ ] **`util.ts` dead utilities** — `mustQuery<T>` and `ignoreError` are written but never called. Two conflicting patterns exist side-by-side: migrate all call sites, then the utilities become load-bearing.
  - Replace 25+ `document.querySelector("#x") as HTMLElement` casts with `mustQuery<HTMLElement>("#x")` — representative sites: `main.ts:35,66,67,118`, `palette.ts:43`, `search.ts:17`, `input-dialog.ts:14`, `filenav.ts:72,80,223`, `settings.ts:131,184,235,257,286`
  - Note: `querySelector<T>` generic form is already used correctly in some places (`settings.ts:130,168`, `tabs.ts:130`, `filenav.ts:155`) — the fix is just consistency
  - Replace all `.catch(() => void 0)` with `ignoreError()` — 12+ sites: `tab-state.ts:42,60,68,147,223,263`, `search.ts:29,43`, `tabs.ts:162,177`, `conflict.ts:30`

- [ ] **`diff.ts:80-81` dead ternary branches** — both branches of two ternaries produce the same value, making the condition dead. Likely a latent off-by-one bug in hunk header generation. Write a test for `@@ -N,M +N,M @@` output and fix.
  ```ts
  // current (wrong):
  const oldStart = firstRaw.type === "add" ? firstRaw.oldNum : firstRaw.oldNum;
  const newStart = firstRaw.type === "del" ? firstRaw.newNum : firstRaw.newNum;
  ```

### Type safety

- [ ] **`api.ts` unchecked casts** — every fetch does `(await res.json()) as T` with no runtime validation. `saveNote` compounds this with `as Record<string, unknown>` then two further `as number`/`as string` casts (`api.ts:78-85`). Add a `requireFields` helper or per-type `parseX(json): X | Error` validator for each response shape.

- [ ] **`events.ts:26,32` internal `Handler<unknown>` casts** — the typed bus downcasts to `Handler<unknown>` internally. Use `Map<string, Set<Handler<any>>>` internally with the typed wrapper as the only public surface.

- [ ] **`editor.ts:1111` untyped return object** — `initEditor()` returns `{ showEditor, hideEditor, … }` with an inferred type. Assign to an explicit `const api: EditorInstance = { … }` before returning so structural mismatches are caught at the definition.

### Architecture

- [ ] **`magic-number 0` save protocol** — `saveNote(..., 0)` means "force overwrite, skip conflict check" (`editor.ts:313`, `conflict.ts:28`) but `0` is also used as "not loaded yet" sentinel in `tab-state.ts:113`. Add `expectedMtime: number | "force"` union in `api.ts` or a dedicated `forceSaveNote(path, content)` helper, and document the protocol.

- [ ] **Rename `tabs.ts` `createNewNote` to `promptNewNote`** — `tab-state.ts:247` and `tabs.ts:15` both export `createNewNote`. `tabs.ts` imports the state-layer version as `_createNewNote` and re-exports a UI wrapper under the same name. "Go to definition" lands on the wrong one. Rename the UI wrapper to `promptNewNote`.

- [ ] **Split `editor.ts` (1100 lines, god module)**
  - `editor-undo.ts`: `undoStack`, `pushUndo`, `undoEdit`, `redoEdit`, `scheduleTypingSnapshot`
    - [ ] **`undoEdit`/`redoEdit` are 95% identical** (`editor.ts:614-650`) — extract `applyUndoEntry(idx: number)` for the shared 20-line body after each boundary check.
  - `editor-save.ts`: `saveCurrentNote`, `_doSave`, autosave timer, `reloadFromDisk` (join the existing `classifySaveResult`/`classifyReload` pure helpers)

- [ ] **`packages/md-wysiwyg` DOM coupling** — the package calls `document.getSelection()` and `document.execCommand` directly in `serialize.ts:37,48`, `transforms.ts:201,231,301`, `inline-transforms.ts:46,74`. This makes it impossible to test without a DOM. Split into a `core` layer (string→string: `markdown.ts`, `format-ops.ts`, `diff.ts`, `merge.ts`, `util.ts`, `highlight.ts`) and a `dom` layer (anything touching globals).

- [ ] **`renderer.ts` invariant is unenforced** — the abstraction intends "only renderer.ts writes HTML to the editor" but `document.execCommand("insertHTML", …)` bypasses it at `inline-transforms.ts:74`, `transforms.ts:208`, `image-paste.ts:36`. Either document that execCommand paths are explicitly exempt, or route through the renderer.

- [ ] **`saveState` missing error check** — `api.ts:237-242` `saveState` POST has no `if (!res.ok) throw` — inconsistent with every other mutating call in the file.

### Code smells & duplication

- [ ] **6 copies of `replaceBlock → null-check → setCursorStart → return`** (`transforms.ts:22-192`) — have `replaceBlock` call `setCursorStart` on its own return value and return `boolean`, eliminating ~30 lines and 12 early-return branches.

- [ ] **`serialize.ts:80-99` 6 near-identical heading branches** — collapse to:

  ```ts
  if (/^H[1-6]$/.test(tag)) {
    const level = +tag[1];
    return { md: `${"#".repeat(level)} ${inlineToMd(el)}`, kind: "heading" };
  }
  ```

- [ ] **`search.ts:27-43` settings fetched twice** — `showScoreBreakdown` is loaded once at construction and again on every open. Extract `async function refreshShowScoreBreakdown()`.

- [ ] **`shiftIndent` in `format-ops.ts:198-280`** — 82-line function with triple-nested conditionals and a redundant condition on line 249: `selStart >= lineAbsStart + (i > 0 ? 1 : 0) && selStart >= lineAbsStart` — the second clause is always implied by the first. Split into: (1) compute indent delta per line, (2) rebuild lines, (3) adjust selection offsets. Unit tests already exist so rewrite is safe.

- [ ] **`markdown.ts:160-174` duplicated block-start condition** — the paragraph lookahead regex (line 165) re-encodes the same stop conditions as the HR check (line 107), code fence (83), heading (99), blockquote (140). Extract `function isBlockStart(line: string): boolean` used by all four.

- [ ] **`highlight.ts:19` const/type name shadowing** — `const Hl = { … } as const` and `type Hl = …` share the same identifier. `grep Hl` matches 40+ lines in the same file. Same pattern for `State` at line 35. Use a distinct alias (e.g. `type HlValue`) or a `const enum`.

- [ ] **`filenav.ts:241-263` duplicate time-format utility** — `timeAgo` here and `relativeTime` in `util.ts:16` both format durations but with different output formats (`"5m ago"` vs `"5m"`). Pick one and delete the other.

- [ ] **`main.ts:335-343` four module-globals for one retry policy** — `sseWasUnavailable`, `sseRetryAttempt`, `nextSseRetryDelay`, `formatRetryDelay`. Encapsulate in a `createBackoff([250, 250, 500, 1000, 1000, 2000, 5000])` helper.

- [ ] **` ` invisible in source** — `editor.ts:100`, `serialize.ts:216,332,391` use literal non-breaking space characters in `.replaceAll(" ", " ")`. Replace with explicit `" "` escape sequences for greppability.

- [ ] **`eslint-disable no-loop-func` cargo-culted** — `tabs.ts:100,105`, `search.ts:149`, `revisions.ts:101` all disable the rule unnecessarily in `for..of .entries()` loops where `const` scoping is already correct. Remove the disables.

## Error handling

- [ ] **Empty `catch` blocks silently swallow user-visible failures** — `main.ts:304-306,313-316,393-396` eat network errors and failed renames/reloads with no user feedback. At minimum surface via `showNotification`.

- [ ] **`image-paste.ts:13-18` unhandled `createImageBitmap` rejection** — corrupt paste images will silently fail. Wrap in try/catch and notify the user.

- [ ] **`revisions.ts:89-97` unhandled restore rejection** — `restore.onclick` is async but has no try/catch around the two awaited calls. Rejected promises are unhandled; user gets no feedback.

- [ ] **`editor.ts:269-283` `saveCurrentNote` swallows `_doSave` errors** — throws from network failures propagate to void callers. Emit a save-failed event through `events.ts`.

- [ ] **`tab-state.ts` inconsistent error visibility** — same file uses silent `.catch` at lines 42/60/68 but `console.warn` at lines 126/190/295. Establish one policy: structural failures warn, best-effort cache ops silent.

## Performance

- [ ] **`scheduleTypingSnapshot` does full `domToMarkdown` every 1s** (`editor.ts:599-612`) — hot path on large notes. Consider storing cursor offset only and computing markdown lazily on undo since undo is rare.

- [ ] **`transforms.ts:209` page-wide `document.querySelector`** — scanning the entire document for `[${CURSOR_ATTR}]`. Fix: pass `contentEl` down from `editor.ts` into `checkBlockInputTransform` / `replaceBlock` and use `contentEl.querySelector(...)` instead.

- [ ] **`reloadFromDisk` does full `domToMarkdown` on every save round-trip** (`editor.ts:341-368`) — the `files:changed` SSE fires on the client's own saves too. Gate by comparing `tab.lastSavedMd === content` before calling `domToMarkdown`.

## Offline resilience

- [ ] Write queue for offline note saves (uses the `queue` IndexedDB store already created in local-store.ts)
- [ ] Full note content caching — proactively cache all notes, not just ones the user has opened
- [ ] Offline note creation — queue `createNote` operations for server sync

## Undo/redo

- [ ] Action-level undo: note delete (cache content, show "Undo" toast with grace period, recreate on undo)
- [ ] Action-level undo: note rename (complex — must also undo backlink updates)
