# Performance

The server remains authoritative for vault state, search, history, and accepted
writes. The browser uses IndexedDB for clean note bodies, keyed by server,
vault, `noteId`, and `contentHash`. Server metadata validates cached content,
and the server response remains authoritative. IndexedDB can be cleared or
evicted; it is not the server backup.

CodeMirror owns the editor document and transactions. The adapter materializes
the whole source only when the app requests a snapshot; ordinary edits report a
revision change. Autosave stores editor snapshots and follows up when edits
arrive during an in-flight save. Browser draft recovery reaches the latest
successfully journaled checkpoint, not every keystroke.

Tantivy search data is derived from the catalog and visible notes. Startup
rebuilds the index when it needs reconciliation. Vault catalogs, history, and
conflict drafts are durable state and are not disposable caches.

Run the focused benchmarks with `make bench`. Run the wider browser and sample
set with `make bench-full`. Both targets are defined in the root `Makefile`.
Run `make bench-long-session` for 20 rounds that open and close notes, edit and
undo, search, and preview an image. The runner delays note and search requests
and fails one note load and one search request. It clears browser resource
timing entries before each forced-GC heap sample, then records DOM element
count, live editor views, editor DOM mounts and removals, event stream count,
server RSS, queue capacities, and overflow count at idle checkpoints under
`.work/tmp/bench-results`. Search queue occupancy is not exposed; the runner
checks the public dirty/degraded state and recorded overflow events.
