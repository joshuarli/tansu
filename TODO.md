### Type safety

- [ ] **`api.ts` unchecked casts** — every fetch does `(await res.json()) as T` with no runtime validation. `saveNote` compounds this with `as Record<string, unknown>` then two further `as number`/`as string` casts (`api.ts:78-85`). Add a `requireFields` helper or per-type `parseX(json): X | Error` validator for each response shape.

- [ ] **`events.ts:26,32` internal `Handler<unknown>` casts** — the typed bus downcasts to `Handler<unknown>` internally. Use `Map<string, Set<Handler<any>>>` internally with the typed wrapper as the only public surface.

- [ ] **`editor.ts:1111` untyped return object** — `initEditor()` returns `{ showEditor, hideEditor, … }` with an inferred type. Assign to an explicit `const api: EditorInstance = { … }` before returning so structural mismatches are caught at the definition.

### Misc

- [ ] **`saveState` missing error check** — `api.ts:237-242` `saveState` POST has no `if (!res.ok) throw` — inconsistent with every other mutating call in the file.

## Error handling

- [ ] **Empty `catch` blocks silently swallow user-visible failures** — `main.ts:304-306,313-316,393-396` eat network errors and failed renames/reloads with no user feedback. At minimum surface via `showNotification`.

- [ ] **`image-paste.ts:13-18` unhandled `createImageBitmap` rejection** — corrupt paste images will silently fail. Wrap in try/catch and notify the user.

- [ ] **`revisions.ts:89-97` unhandled restore rejection** — `restore.onclick` is async but has no try/catch around the two awaited calls. Rejected promises are unhandled; user gets no feedback.

- [ ] **`editor.ts:269-283` `saveCurrentNote` swallows `_doSave` errors** — throws from network failures propagate to void callers. Emit a save-failed event through `events.ts`.

- [ ] **`tab-state.ts` inconsistent error visibility** — same file uses silent `.catch` at lines 42/60/68 but `console.warn` at lines 126/190/295. Establish one policy: structural failures warn, best-effort cache ops silent.

## Offline resilience

- [ ] Write queue for offline note saves (uses the `queue` IndexedDB store already created in local-store.ts)
- [ ] Full note content caching — proactively cache all notes, not just ones the user has opened
- [ ] Offline note creation — queue `createNote` operations for server sync

## Undo/redo

- [ ] Action-level undo: note delete (cache content, show "Undo" toast with grace period, recreate on undo)
- [ ] Action-level undo: note rename (complex — must also undo backlink updates)
