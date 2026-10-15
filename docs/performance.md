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

## Recorded results

On 2026-10-14, the corrected search-to-painted benchmark measured the original
Rust path at 743.4 ms median and 769.2 ms p95. The optimized path measured
44.9 ms median and 51.7 ms p95. The earlier `chromium.search` result measured
the API request, not painted results. API p95 fell from 781 ms to 31.02 ms.
The idle-host `make bench` gate passed its 100 ms search-to-painted target.

The 2026-10-14 long-session run used Chromium 156.0.8078.4 and 20 rounds. Heap
after forced GC grew by 2,668,000 bytes and tapered over the final five
checkpoints. No leak root was established, and the cause of the growth remains
unresolved.

The 2026-10-15 long-session run used 100 rounds. Heap after forced GC grew from
5.74 MB to 8.35 MB: 1.9 MB over the first 20 rounds, then about 9 KB per round
falling to about 4 KB per round. DOM element count held at 48 and live editor
views at 1. Server RSS grew about 17 KB per round, consistent with accepted
saves accumulating history. The growth is sublinear and no leak root was found.
