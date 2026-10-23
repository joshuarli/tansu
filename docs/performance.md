# Performance

The server owns durable vault state and search. Browser caches are disposable;
editor snapshots and recovery checkpoints are described in
[Architecture](architecture.md) and [Editor](editor.md). Benchmark targets and
the recorded result are below.

The vault calls the search service directly while holding its search mutex.
Rebuild clears and recreates only the derived index from canonical note
documents. On startup, the host compares the index with the catalog and
rebuilds it when needed, including after an interrupted rebuild.

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

On 2026-10-23, five interleaved pairs of release server binaries on macOS and
Chromium measured `searchPainted` at 46.5 ms median (46.2–47.1) with the inner
worker and 46.3 ms (46.2–46.5) with direct calls. Each side had one measured
run after two warmups per pair, and every run passed both load gates. The
end-to-end latency difference is within the observed spread. `/search` measured
1.16 ms median (1.07–1.69) and 1.01 ms (0.93–1.11), respectively; those ranges
overlap. Median server RSS fell from 59,146,240 bytes (56,918,016–61,227,008)
to 52,068,352 bytes (51,281,920–53,264,384). The release server binary fell
from 8,771,904 to 8,704,800 bytes. The production bundle remained 849,382
bytes, below its 850,000-byte limit.

On 2026-10-23, five baseline reloads with 96 cold wiki images and four
concurrent requests first requested a restored-viewport image in round 21 or 22.
Five reloads with visible-image priority requested one in round 1. This compares
request order, not full image-load time.
