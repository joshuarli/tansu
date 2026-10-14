# Performance

The server remains authoritative for vault state, search, history, and accepted
writes. The browser uses an IndexedDB cache for clean note bodies, keyed by
vault, `noteId`, and `contentHash`. Server metadata validates cached content,
and the server response remains authoritative.

The editor stores Markdown in a line-based model. Ordinary typing reconciles the
active line into that model instead of serializing the whole document on every
keystroke. Autosave uses editor snapshots and a per-tab follow-up flag for edits
made during an in-flight save.

Run the focused benchmarks with `make bench`. Run the wider browser and sample
set with `make bench-full`. Both targets are defined in the root `Makefile`.
