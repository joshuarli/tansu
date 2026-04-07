# TODO

## Offline resilience

- [ ] Write queue for offline note saves (uses the `queue` IndexedDB store already created in local-store.ts)
- [ ] Full note content caching — proactively cache all notes, not just ones the user has opened
- [ ] Offline note creation — queue `createNote` operations for server sync

## Undo/redo

- [ ] Action-level undo: note delete (cache content, show "Undo" toast with grace period, recreate on undo)
- [ ] Action-level undo: note rename (complex — must also undo backlink updates)
