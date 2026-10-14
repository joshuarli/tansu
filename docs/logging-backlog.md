# Logging backlog

Proposed work not present in the current log stream:

- Propagate a trace id from each user action through client and server events.
- Record completion durations for compound operations such as note opens,
  saves, and reconciliation.
- Include client and harness state snapshots in e2e failure output.
- Add typed event constructors for Rust and TypeScript event kinds.
- Filter snapshots by source, level, kind, request, note, and sequence.
- Add a local viewer with live filtering and trace grouping.
- Add per-kind noise controls and normalized error fields.
- Attach filtered traces and screenshots to e2e failures.
- Report dropped-event counts and truncation metadata.
