# Performance

The server owns durable vault state and search. Browser caches are disposable;
editor snapshots and recovery checkpoints are described in
[Architecture](architecture.md) and [Editor](editor.md). Benchmark targets and
the recorded result are below.

Run the focused benchmarks with `make bench`. Run the wider browser and sample
set with `make bench-full`. Both targets are defined in the root `Makefile` and run `perf-gate-ready` before measuring and
`perf-gate-ready -1` right after. If either check reports a busy host, the
target deletes the result files written during the run, prints `perf gate
deferred: host busy`, and exits 75. A deferred run is not a pass. The shared
recipe is `scripts/perf-gate.sh`.

## Recorded results

On 2026-10-14, the corrected search-to-painted benchmark measured the original
Rust path at 743.4 ms median and 769.2 ms p95. The optimized path measured
44.9 ms median and 51.7 ms p95. The earlier `chromium.search` result measured
the API request, not painted results. API p95 fell from 781 ms to 31.02 ms.
The idle-host `make bench` gate passed its 100 ms search-to-painted target.
