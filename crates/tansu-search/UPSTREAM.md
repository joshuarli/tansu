# Ferrisearch core provenance

`src/index.rs`, `src/schema.rs`, `src/search.rs`, `src/tokenizer.rs`, and `src/types.rs` derive from [`ferrisearch-core`](https://github.com/joshuarli/ferrisearch/tree/039b6b208e4d282416057ab1151cf310c89de108), commit `039b6b208e4d282416057ab1151cf310c89de108`.

The imported code is licensed under LGPL-3.0-or-later. `LICENSE` contains the upstream license text.

Local changes adapt the index to Tansu note identity and source revisions, remove browser-only and filesystem-free paths, use typed query options and checked limits, add source and excerpt ranges, add quick-open and request-scoped overlays, and give the index a persistent lifecycle with failure recovery.

`tests/goldens/reference-parity.tsv` records sorted candidate IDs from seven queries over a six-note corpus, run against this commit and the Tansu port. Six queries return the same candidates. The `dessert` query returns two Tansu notes from their supported tags; Ferrisearch returns no tag-only hits. The `"quick brown"` query returns the same candidates in a different rank order because Tansu uses fixed title and path weights. The golden compares candidate IDs because the port returns bounded excerpts and typed ranges instead of full note bodies.

To update the imported code, compare the pinned source against the upstream commit, apply upstream changes to the adapted implementation, preserve `LICENSE`, and run `cargo test -p tansu-search`.
