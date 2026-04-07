# Offline resilience

Tansu uses IndexedDB as a local cache so the frontend can survive hours-long server outages without losing session state or access to previously-opened notes.

## Layers

### IndexedDB local store (`local-store.ts`)

Database `"tansu"`, version 1. Three object stores:

| Store     | Key              | Value                      | Purpose                                  |
| --------- | ---------------- | -------------------------- | ---------------------------------------- |
| **kv**    | string           | any                        | Session state (key `"session"`)          |
| **notes** | path (string)    | `{ content, mtime }`      | Cached note content                      |
| **queue** | auto-increment   | *(reserved)*               | Future: offline write queue              |

All public functions (`kvGet`, `kvPut`, `noteGet`, `notePut`, `noteDel`) gracefully no-op when the store hasn't been opened (i.e. `openStore()` was never called or `closeStore()` was called). This means the rest of the app doesn't need to know or care whether IDB is available.

### Note fetching (`fetchNote` in `tab-state.ts`)

Single function implementing the cache-aside pattern:

1. Try `getNote()` from the server
2. On success: cache to IDB via `notePut()`, return the note
3. On failure: try `noteGet()` from IDB
4. If cached: return it
5. If not cached: throw `"Note {path} not available offline"`

All note-reading paths (`openTab`, `switchTab`, `restoreSession`) go through `fetchNote`.

Note content is written to IDB on four occasions:
- **Fetch**: `fetchNote()` caches every successful server response
- **Save**: `markClean()` caches the content after a successful PUT
- **Close**: `closeTab()` caches the tab's current content (ensures reopen works offline)

### Session state persistence

`persistState()` writes to both IDB and the server on every state change. Both are fire-and-forget:

```
persistState() → kvPut("session", state)   // always succeeds locally
               → saveState(state)           // best-effort, may fail silently
```

`restoreSession()` tries the server first, falling back to IDB:

```
restoreSession() → getState()               // try server
                   → success: cache to IDB, use it
                   → failure: kvGet("session"), use cached state
```

On SSE reconnect, `syncToServer()` reads the latest state from IDB and pushes it to the server. This ensures any state changes made while offline (tab opens/closes, closed-tab stack changes) are eventually persisted server-side.

### Closed-tab stack

A bounded LIFO stack (max 20 entries) of recently closed tab paths. Persisted as part of session state (`closed` field in `state.json`).

- `closeTab()` pushes the path
- `reopenClosedTab()` (Cmd+Shift+T) pops and calls `openTab()`
- If the popped path is already open, `openTab()` switches to it (no duplicate)
- `restoreSession()` restores the stack from server/IDB state

## Data flow diagram

```
                    ┌─────────────┐
    openTab ───────>│ fetchNote() │
    switchTab ─────>│             │
    restoreSession >│  server?    │──yes──> return + cache to IDB
                    │  ↓ no       │
                    │  IDB cache? │──yes──> return cached
                    │  ↓ no       │
                    │  throw      │
                    └─────────────┘

                    ┌──────────────────┐
    tab change ────>│  persistState()  │──> IDB (always)
    tab close ─────>│                  │──> server (best-effort)
    tab reopen ────>│                  │
                    └──────────────────┘

    SSE connected ──> syncToServer() ──> read IDB → push to server
```

## Encryption considerations

When the app locks (encrypted vault), `closeStore()` should be called to close the IDB connection. A future enhancement should clear the `notes` store on lock to avoid leaking plaintext note content in IndexedDB. Session state (tab paths, not content) is safe to retain.

## Future work

See `TODO.md` for planned extensions:
- **Write queue**: queue note saves/creates/deletes in the `queue` IDB store during offline, drain on reconnect with mtime-based conflict detection
- **Action-level undo**: delete (cache content + grace-period toast), rename (complex due to backlink updates)
- **Proactive caching**: cache all notes on first load, not just ones the user has opened
