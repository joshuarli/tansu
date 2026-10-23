# Logging

The dev and e2e log stream combines Rust server, browser, and harness events for
local debugging.

## Modes

Set `TANSU_LOGS` to `off`, `buffer`, or `pretty`. The server defaults
to `off`. Development frontend builds default to `pretty`. Production builds
default to `off`. `make dev` enables pretty server logs. The browser e2e task
uses buffered logging. Rust release builds disable the log hub. The `pretty` mode prints each bounded
structured event as one JSON line, including its raw fields, without ANSI colors
or a separate event summary.

## Events

The server assigns a global sequence and timestamp when it accepts each event.
Events have `seq`, `ts`, `source`, `level`, and `kind` fields, an optional
`requestId`, and kind-specific fields. `requestId` links a browser API event to
its server request. `seq` gives the canonical order. The bounded log hub
truncates oversized events and drops the oldest when full; its limits are in
`src/logging.rs`. Never log note bodies, request or response bodies, pasted
image bytes, or imported page content.

## Dev endpoints

These endpoints are available only when logging is enabled:

| Method | Path                   | Purpose                         |
| ------ | ---------------------- | ------------------------------- |
| `POST` | `/api/dev/logs`        | Ingest browser or harness events |
| `GET`  | `/api/dev/logs`        | Read the retained snapshot       |

Snapshots have the shape `{ "events": [] }`. These endpoints are excluded from
normal request logging and are not part of the generated API types.

## Event sources

- `src/logging.rs` assigns sequence numbers, bounds the buffer, and formats
  server output.
- `src/http.rs`, `src/app.rs`, and `src/vault.rs` emit server events.
- `web/ts/dev-log.ts` batches browser events and captures runtime errors.
- The e2e harness forwards page errors and failed requests, then prints the
  retained event stream after a test failure.

Browser logging does not patch `console.*`. If log transport fails, the browser
disables further event sending for that session. E2e failure output is ordered
by `seq` and retains server stdout/stderr as a fallback.

See the [logging backlog](logging-backlog.md) for proposed improvements.
