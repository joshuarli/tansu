# Logging

Tansu2 has a unified dev/test log stream for debugging behavior that crosses the
Rust server, browser client, and e2e harness. It is intentionally not a
production observability system.

This document describes the current logging architecture. Planned improvements
and prioritization live in [LOGGING-TODO.md](../LOGGING-TODO.md).

The server is the ordering authority. Server events are emitted directly into
the log hub. Browser and harness events are posted to the server, where they are
assigned the same global sequence as server events. This keeps failure dumps
readable without trying to align browser and server clocks.

## Modes

Logging is controlled by `TANSU2_LOGS`:

| Value    | Behavior                                                  |
| -------- | --------------------------------------------------------- |
| `off`    | Disable logging.                                          |
| `buffer` | Keep the in-memory log buffer only.                       |
| `pretty` | Keep the buffer and print colored timestamped text lines. |
| `json`   | Keep the buffer and print newline JSON.                   |

Defaults and commands:

- `make dev` runs the server with `TANSU2_LOGS=pretty`.
- `deno task test:browser` builds the browser with `TANSU2_LOGS=buffer` and runs the
  server with `TANSU2_LOGS=buffer`.
- Production browser bundles define `TANSU2_LOGS=off`.
- Rust release builds compile the real log hub behavior out behind
  `debug_assertions`; call sites should still check `logs.enabled()` before
  building structured JSON payloads.

## Event Shape

Log events use a small server-assigned envelope plus structured event fields:

```ts
type LogEvent = {
  seq: number;
  ts: number;
  source: "server" | "client" | "harness";
  level: "debug" | "info" | "warn" | "error";
  kind: string;
  requestId?: string;
} & Record<string, unknown>;
```

- `seq` is the canonical order. Sort and read snapshot logs by `seq`.
- `ts` is the server-side millisecond timestamp when the event was accepted.
- `source` identifies where the event originated.
- `kind` is the stable event category, such as `http.request`,
  `note.mutation`, `client.command`, `client.api`, `client.error`, or
  `system.event`.
- `requestId` correlates client API calls with the matching server HTTP request.

Do not depend on browser timestamps for ordering. If client-side timing matters,
put it inside that event's structured payload.

## Structured Fields

Prefer stable structured fields over freeform messages. Common payload objects:

- `http`: method, path or URL, status, duration, and vault.
- `note`: note id, path, vault, content hash, catalog sequence.
- `mutation`: note mutation action, such as `create`, `save`, `rename`,
  `delete`, `restore`, or `restore_conflict`.
- `system`: component and action, such as `startup/listen`, `sse/connect`,
  `watcher/reconcile`, or `search/degraded`.
- `command`: client command id and command-specific options.
- `editor`: editor lifecycle and mode changes.
- `search`: search surface, query length, and hit counts.
- `settings`: persisted settings summary.
- `session`: persisted session summary.
- `revision`: revision id, note id, hash, and byte count.
- `asset`: uploaded asset name, byte count, and vault.
- `error`: structured error details or generated API error payloads.
- `client`: browser diagnostic context, including client-local sequence and URL.
- `page`: page URL for browser runtime errors.

Avoid logging note bodies, raw request bodies, pasted image bytes, or other large
content. Log ids, paths, hashes, sizes, statuses, and structured error codes
instead.

## Retention And Bounds

The server log hub keeps an in-memory ring buffer of up to 100,000 events and an
approximate byte cap. Oldest events are dropped first when either limit is hit.
Large strings, arrays, objects, and oversized events are truncated before
storage. These bounds keep logging useful during noisy failures without making
the logger the failure mode.

## Dev Endpoints

Dev endpoints are only available when logging is enabled:

| Method | Path                   | Purpose                         |
| ------ | ---------------------- | ------------------------------- |
| `POST` | `/api/dev/logs`        | Ingest client or harness events |
| `GET`  | `/api/dev/logs`        | Read the retained snapshot      |
| `GET`  | `/api/dev/logs/stream` | Subscribe to live events by SSE |

These endpoints are private dev/test infrastructure. They are intentionally not
part of the generated public API types and are excluded from request logging to
avoid recursive log spam.

Client and harness ingestion uses this body:

```json
{
  "events": [
    {
      "source": "client",
      "level": "info",
      "kind": "client.api",
      "requestId": "cli-...",
      "http": {
        "method": "GET",
        "path": "/api/bootstrap",
        "status": 200,
        "durationMs": 12,
        "vault": 0
      }
    }
  ]
}
```

Snapshot responses use:

```json
{ "events": [] }
```

Pretty output prints one line per event: a standard UTC timestamp, colored
level/source/kind, a short event-specific summary, and a low-contrast compact
JSON payload. The sequence remains in JSON snapshots for deterministic ordering,
but it is not the primary visual label in pretty output.

## Browser Logging

The browser logger lives in `web/ts/dev-log.ts`.

It captures:

- explicit client events from app/API code,
- API request summaries with `X-Tansu-Request-Id`,
- `window.error`,
- `unhandledrejection`,
- a final best-effort flush on `beforeunload`.

It does not patch `console.*`. If log transport fails, browser log sending is
disabled for the rest of the session so logging failures do not recursively
create more logs.

## Server Logging

Server logging is owned by `App` and `LogHub`:

- `src/logging.rs` defines the private event types, ring buffer, truncation, and
  subscribers.
- `src/http.rs` emits one `http.request` event for normal routed requests.
- `src/app.rs` emits startup and SSE lifecycle events.
- `src/vault.rs` emits note read/mutation, pin, settings, session, revision,
  asset, watcher, search, and vault-open events.

Request logs include method, path, vault, status, duration, and API error
payloads when available. They do not include request or response bodies.

## E2E Failure Dumps

The e2e harness runs with `TANSU2_LOGS=buffer`. On test failure, Vitest's
per-test failure hook fetches `/api/dev/logs` and prints the retained unified
stream. The harness also forwards Playwright page errors and failed requests as
`harness` events, and keeps raw server stdout/stderr as a fallback if the log
endpoint is unavailable.

Read e2e failure output by `seq`. A typical API failure should show:

1. client command, editor, search, or API event,
2. matching server `http.request` with the same `requestId`,
3. server domain outcome or generated API error,
4. browser or harness errors that happened around the same sequence.

## Adding Logs

When adding a log:

- Use an existing `kind` and structured field name when it fits.
- Add new `kind` values only for genuinely distinct event types.
- Keep payloads bounded and body-free.
- Check `logs.enabled()` before building expensive Rust payloads.
- Include `requestId` on client-initiated API work.
- Prefer one wide event for a completed operation over many small progress logs.

Logging must not affect vault correctness. Failed log ingestion or disabled
logging should never fail user-visible app behavior.
