# Tansu TODO

Prefix: TNS
Next: 108

### TNS-085 · P1 · Pending materialization publishes a source hash the file does not have

- **Area:** Data
- **Where:** `src/catalog.rs:338`, `src/vault.rs:1746`, `src/vault.rs:1426`, `src/vault.rs:2722`, `src/vault.rs:486`, `src/app.rs:39`
- **Problem:** `accept_note_content_mutation` stores the submitted `content_hash` and leaves `visible_hash` at the pre-image, then sets the mutation to `pending_materialization`. If the visible write fails, or the file changes before replace, `v2_save_source` returns `pendingMaterialization` and does not roll the catalog back (`src/vault.rs:1746`). `v2_open_note` then reads the visible file in `read_visible_or_snapshot` and pairs those bytes with the new catalog hash (`src/vault.rs:1431`, `src/vault.rs:2726`). The response body is not the accepted source. The same window exists for create and rename: the catalog path is committed before the file move, so open can 404 a note that `v2_notes` still lists. Restart repair rewrites the file when the bytes still match the pre-image (`startup_repairs_pending_content_mutation_before_reconciliation`). If they do not, `repair_pending_mutation` returns `Error::Internal` and `VaultRuntime::open` fails (`startup_pending_repair_preserves_unexpected_external_bytes`). `App::from_config` opens vaults with `?`, so one vault stops the process (`src/app.rs:39`). Proof is the control flow above, not a new run: this checkout has no `target/` or `node_modules`, so the existing tests were not executed. Priority assumed.
- **Recommendation:** While a mutation is `pending_materialization`, content reads must return the snapshot bytes for that source hash, or a pending error, and must not return other bytes under that hash. On startup, unexpected visible bytes must not fail sibling vaults. Record the note unresolved or as a conflict and keep the snapshot. Do not overwrite bytes that are neither the pre-image nor the candidate.
- **Fix with:** durable-state
- **Effort:** M
- **Design:** [docs/rfc/TNS-085-pending-materialization.md](docs/rfc/TNS-085-pending-materialization.md)

### TNS-086 · P2 · Modal host booleans allow overlapping overlays and duplicate backdrops

- **Area:** Types
- **Where:** `web/ts/state.ts:113-135`, `web/ts/view.ts:633-736`, `web/ts/app.ts:2613-2629`
- **Problem:** `State` represents modal UI overlays with six independent booleans (`commandOpen`, `searchOpen`, `findOpen`, `revisionsOpen`, `settingsOpen`, `helpOpen`) plus three nullables (`noteDialog`, `contextMenu`, `conflictDraft`). These admit 512 state combinations for what is a mutually exclusive view mode. In `renderOverlays`, multiple independent `if` statements append separate modal panels and duplicate `<div class="backdrop">` elements into the DOM when multiple flags are true. Opening handlers in `app.ts` only clear a subset of flags (e.g. `searchOpen = true` clears `findOpen` and `commandOpen` but leaves `settingsOpen`, `helpOpen`, and `revisionsOpen` unchanged). Priority assumed.
- **Recommendation:** Replace the 6 booleans and nullables with a single discriminated union `activeOverlay: null | { kind: "command" } | { kind: "search" } | { kind: "find" } | { kind: "revisions" } | { kind: "settings" } | { kind: "help" } | { kind: "dialog"; dialog: NoteDialog } | { kind: "contextMenu"; menu: ContextMenuState }`.
- **Fix with:** make-invalid-states-unrepresentable
- **Effort:** S

### TNS-087 · P2 · TabFields flattens document session lifecycle into an invalid boolean product

- **Area:** Types
- **Where:** `web/ts/state.ts:31-60`, `web/ts/app/document-controller.ts:14-27`, `web/ts/app/document-session.ts:57-84`
- **Problem:** `TabFields` models document status using `draft: string | null`, `dirty: boolean`, `saving: boolean`, `conflict: boolean`, `editorSession: EditorSession | null`, `session: DocumentSession | null`, and `doc: V2NoteDocument | null`. This product permits 128 states for 8 actual phases, allowing contradictory combinations like `saving: true` when `doc: null`, `conflict: true` when `dirty: false`, or `dirty: true` when `draft: null`. While `DocumentSession` defines an explicit discriminated union `DocumentSessionState`, `dirtySnapshot` and `TabFields` flatten it back into booleans. Priority assumed.
- **Recommendation:** Embed the session state directly in `SavedTab` as a discriminated union and remove the redundant `dirty`, `saving`, `conflict`, and `draft` properties from `TabFields`.
- **Fix with:** make-invalid-states-unrepresentable
- **Effort:** M

### TNS-088 · P2 · App bootstrap and vault switching rely on scattered flags with 15+ defensive guards

- **Area:** Architecture
- **Where:** `web/ts/app.ts:130-150`, `web/ts/app.ts:173`, `web/ts/app.ts:474-495`, `web/ts/app.ts:652-712`
- **Problem:** App-level lifecycle is tracked across `bootGeneration`, `sessionGeneration`, `transitioningVault`, `noVaultConfigured`, `disposed`, `state.boot`, `state.authRequired`, and `state.authBusy`. Asynchronous callbacks throughout `app.ts` must repeat brittle 5-condition guards (`if (generation !== this.bootGeneration || this.transitioningVault || this.disposed || ...)`). Incomplete checks allow stale callbacks to execute across vault transitions or after disposal. Priority assumed.
- **Recommendation:** Model top-level app lifecycle with an explicit state machine type (`Uninitialized | BootingGlobal | AuthLocked | EmptyVault | BootingVault | Ready | Disposed`) with transitions owned by a centralized controller.
- **Fix with:** make-invalid-states-unrepresentable
- **Effort:** M

### TNS-089 · P2 · Document controller allows task registration and reattachment during close flush

- **Area:** Concurrency
- **Where:** `web/ts/app/document-controller.ts:48-132`, `web/ts/app/document-controller.ts:181-196`
- **Problem:** `DocumentController` manages lifecycle via `load`, `mutations: Set<Promise<unknown>>`, `tasks: Set<ControllerTask>`, and `session: SessionSource | null`. When `close(session, "flush")` runs, it enters an intermediate state awaiting `mutations` before saving and closing. During this settling window, the controller remains in `DocumentControllers`, allowing `beginTask` or `attachSession` calls to race the closing flush. Priority assumed.
- **Recommendation:** Add an explicit lifecycle state to `DocumentController` (`Active | Closing | Retired`) that rejects new tasks and attachments once close has begun.
- **Fix with:** lifecycle-concurrency
- **Effort:** S

### TNS-090 · P2 · Local draft session promotion failure permanently locks editing

- **Area:** Types
- **Where:** `web/ts/app/local-draft-session.ts:5-18`, `web/ts/app/local-draft-session.ts:90-123`
- **Problem:** `LocalDraftSessionState` uses `promotionPending: boolean` to guard against concurrent edits during server note creation. If `beginPromotion()` succeeds but the downstream network call or note creation rejects, `promotionPending` remains `true` on the recovered session, causing all subsequent `edit()` and `editTitle()` calls to throw `TypeError("Cannot edit a local draft while its create request is pending")`. Priority assumed.
- **Recommendation:** Model the session lifecycle as an explicit state union (`Drafting | Promoting | Promoted`) and provide an explicit transition back to `Drafting` with error context upon promotion rejection.
- **Fix with:** make-invalid-states-unrepresentable
- **Effort:** S

### TNS-091 · P2 · DraftJournal debounce and write pipeline permits clear race during timer window

- **Area:** Concurrency
- **Where:** `web/ts/app/workspace-store.ts:101-188`, `web/ts/app/workspace-store.ts:230-249`
- **Problem:** Draft checkpointing coordinates state across three independent collections: `pending: Map`, `timers: Map`, and `writes: Map`. In `clearPendingCheckpoint`, clearing a checkpoint checks `pending`, deletes timers, and chains onto `writes`. If a rapid edit re-arms a timer between checkpoint resolution and write chaining, stale drafts can be cleared or newer drafts can be dropped. Priority assumed.
- **Recommendation:** Consolidate draft checkpoint lifecycle per note into a single state machine object per key (`Idle | Debouncing | Writing | Clearing`) that serializes transitions atomically.
- **Fix with:** lifecycle-concurrency
- **Effort:** M

### TNS-092 · P2 · Revision inspector fields permit desynchronized note diffs and missing documents

- **Area:** Types
- **Where:** `web/ts/state.ts:124-129`, `web/ts/view.ts:879-920`, `web/ts/app.ts:1813-1826`
- **Problem:** Revisions state is spread across six fields in `State`: `revisionsOpen`, `revisionNoteId`, `revisionList`, `revisionSelectedEventId`, `revisionDocument`, and `conflictDraft`. When switching tabs, `revisionsOpen` remains `true` while the active note changes, creating states where `revisionDocument` belongs to a previous note or `revisionSelectedEventId` does not exist in `revisionList`. Priority assumed.
- **Recommendation:** Replace the 6 fields with a discriminated union `revisions: null | { status: "loading-list"; noteId } | { status: "list-ready"; noteId; list } | { status: "loading-doc"; noteId; list; eventId } | { status: "ready"; noteId; list; doc }`.
- **Fix with:** make-invalid-states-unrepresentable
- **Effort:** S

### TNS-093 · P2 · Durable mutation operations use magic strings in SQLite and untyped records

- **Area:** Data
- **Where:** `src/catalog.rs:30-44`, `src/catalog.rs:294-350`, `src/vault.rs:244-259`, `src/vault.rs:283-318`
- **Problem:** `mutation_operations.state` in SQLite stores magic text strings (`'prepared'`, `'pending_materialization'`, `'accepted'`, `'conflict'`), and `MutationRecord.state` in Rust is a plain `String`. The database permits storing `'accepted'` with `result_json IS NULL`, or `'pending_materialization'` without `source_hash` or `note_id`. Call sites in `src/vault.rs` must perform ad-hoc string comparisons and defensive `ok_or_else` unpacking on every lookup. Priority assumed.
- **Recommendation:** Introduce a strongly-typed `MutationState` enum in `catalog.rs` with exhaustive matching and validate column invariants upon reading from SQLite.
- **Fix with:** durable-state
- **Effort:** M

### TNS-094 · P3 · Note title widget in-place editing relies on closure flags and DOM blur races

- **Area:** Types
- **Where:** `web/ts/editor/codemirror-adapter.ts:82-148`
- **Problem:** `NoteHeaderWidget` coordinates note title renaming via mutable closure variables (`titleAtFocus`, `canceled`, `submitOnEnter`) and DOM events. A blur event fired while `onTitleCommit` is already in flight can trigger a duplicate commit or race with user cancellation. Priority assumed.
- **Recommendation:** Model the in-place title editor with an explicit state machine (`Idle | Editing | Committing | Reverting`) and ignore DOM blur/focus events while in `Committing`.
- **Fix with:** make-invalid-states-unrepresentable
- **Effort:** S

### TNS-095 · P3 · Pasted image upload leaks blob URLs and widgets on session detachment

- **Area:** Concurrency
- **Where:** `web/ts/editor/codemirror-adapter.ts:335-346`, `web/ts/editor/codemirror-adapter.ts:767-799`, `web/ts/editor/pasted-image-preview.ts:38-65`
- **Problem:** Image paste handles multi-step encoding and upload via `PendingImagePaste` with boolean `finished`, `controller`, and `previewUrl`. If an editor session is detached or replaced while WebP encoding or upload is running, cleanup relies on manual catch blocks; failed early exits can leak object URLs in browser memory. Priority assumed.
- **Recommendation:** Wrap image paste lifecycle in an explicit state machine that guarantees object URL revocation on transition to any terminal state (`Inserted | Stale | Failed | Cancelled`).
- **Fix with:** lifecycle-concurrency
- **Effort:** S

### TNS-096 · P3 · Wiki preview hover card coordinates dual timers without mutually exclusive state

- **Area:** Concurrency
- **Where:** `web/ts/editor/wiki-preview.ts:22-26`, `web/ts/editor/wiki-preview.ts:66-70`, `web/ts/editor/wiki-preview.ts:77-78`
- **Problem:** `wikiPreviewCards` manages preview hover timing using independent `showTimer: number | null` and `hideTimer: number | null` fields alongside an `AbortController`. Rapid pointer movements across link boundaries allow both timers to be active simultaneously, risking stale preview cards rendering over newer link targets. Priority assumed.
- **Recommendation:** Model the preview tooltip with an explicit state union (`Idle | HoverPending | Loading | Showing | LeavePending`) that clears pending timers and aborts in-flight requests on every transition.
- **Fix with:** lifecycle-concurrency
- **Effort:** S

### TNS-097 · P3 · Extension import receiver coordinates queue and cancellation with ad-hoc epoch

- **Area:** Concurrency
- **Where:** `web/ts/app/extension-import-receiver.ts:88-135`
- **Problem:** `createExtensionImportReceiver` coordinates image localization and note creation using an integer `epoch`, `controller: AbortController`, and a promise chain `queue`. Cancellation increments `epoch` and aborts the controller, but queued tasks check `requestEpoch !== epoch` only after previously chained tasks finish. Priority assumed.
- **Recommendation:** Implement import request processing as an explicit worker state machine that drains or discards queued items immediately upon vault cancellation.
- **Fix with:** lifecycle-concurrency
- **Effort:** S

### TNS-098 · P3 · Block drag handles permit desynchronized block indices during document changes

- **Area:** Concurrency
- **Where:** `web/ts/editor/block-drag.ts:74-105`
- **Problem:** `BlockDragHandles` tracks drag-and-drop state via `hovered: number`, `dragging: { index; gap } | null`, and `settleTimer: number | null`. If an external edit or transaction changes the document structure during an active drag or settle animation, block indices become stale and can apply moves to wrong positions. Priority assumed.
- **Recommendation:** Track dragged blocks by stable position markers or cancel the drag state machine immediately upon any document transaction that affects lines outside the dragged block.
- **Fix with:** lifecycle-concurrency
- **Effort:** S

### TNS-099 · P3 · Catalog notes table represents note state across split tombstoned and unresolved columns

- **Area:** Data
- **Where:** `src/catalog.rs:1026-1042`, `crates/tansu-note-core/src/state.rs:4-28`
- **Problem:** The SQLite `notes` table stores note status across `tombstoned INTEGER` and `unresolved TEXT` columns. This schema permits an invalid state where `tombstoned = 1` and `unresolved = 'invalid_utf8'` are both true. In Rust, `NoteRow.state` must decode these into `NoteState::Live | NoteState::Unresolved | NoteState::Tombstoned` with custom branching. Priority assumed.
- **Recommendation:** Unify `tombstoned` and `unresolved` into a single `state TEXT` column in `notes` storing `live`, `tombstoned`, or the unresolved reason tag.
- **Fix with:** durable-state
- **Effort:** S

### TNS-100 · P3 · Vault reconciliation pipeline relies on ad-hoc collection sorting and index pairs

- **Area:** Architecture
- **Where:** `src/reconcile.rs:17-105`
- **Problem:** `reconcile_vault` classifies filesystem entries against catalog rows using seven ad-hoc collections (`seen_keys`, `primary_files`, `live_rows`, `unmatched_rows`, `unmatched_files`, `moved_pairs`, `consumed`). Transitions (such as case collision quarantine, hash move matching, and tombstoning) are coordinated through index tuples and removal passes without an explicit file disposition type. Priority assumed.
- **Recommendation:** Model reconciliation file classification with an explicit `ReconciliationDisposition` enum (`LiveMatch | ExternalEdit | UnambiguousMove | CaseCollision | Tombstone | NewNote`) processed in declared stages.
- **Fix with:** make-invalid-states-unrepresentable
- **Effort:** M

### TNS-101 · P3 · SSE body state allows live stream closure while replay buffer has items

- **Area:** Concurrency
- **Where:** `src/http.rs:1303-1370`
- **Problem:** `SseBodyState` coordinates event streaming across `replay: VecDeque<Bytes>`, `live: bool`, `event_bridge`, and multiple deadline instants. When an event requires resynchronization, `self.live = false` is set immediately, which can cause the stream to terminate or skip backlog items if `replay` still has pending frames. Priority assumed.
- **Recommendation:** Model the SSE body state as an explicit enum (`Replaying { queue } | Live { receiver } | ResyncRequired | Closed`) to prevent premature termination while frames remain.
- **Fix with:** lifecycle-concurrency
- **Effort:** S

### TNS-102 · P3 · SSE client reconnection loop manages 5 phases via ad-hoc while loops and delays

- **Area:** Concurrency
- **Where:** `web/ts/app/v2-api.ts:870-948`
- **Problem:** `subscribeV2Events` runs an asynchronous while loop managing five distinct phases (Connecting, Streaming, Resyncing, BackoffWaiting, Stopped) through nested loops, `attempt` counters, and buffer string concatenation. Exception paths can lead to multiple delayed reconnect attempts if state is not cleanly reset. Priority assumed.
- **Recommendation:** Refactor the SSE subscription client into an explicit state machine object where state transitions and backoff delays are distinct methods with explicit cancellation.
- **Fix with:** lifecycle-concurrency
- **Effort:** S

### TNS-103 · P3 · Session lease RAII tracking coordinates revocation via manual count and token

- **Area:** Concurrency
- **Where:** `src/auth.rs:185-212`, `src/auth.rs:583-596`
- **Problem:** `SessionLease` and `ActiveLease` maintain an in-memory lease count for active SSE streams. A dropped lease decrements a counter under a mutex in `Drop`, and revocation cancels an inner `CancellationToken`. If leases are cloned or leaked across tasks, session revocation can fail to terminate active HTTP streams promptly. Priority assumed.
- **Recommendation:** Encapsulate lease state in an explicit lifecycle type with audited drop behavior and explicit revocation channels.
- **Fix with:** lifecycle-concurrency
- **Effort:** S

### TNS-104 · P3 · WebAuthn ceremonies table stores untyped string kind and loose ticket references

- **Area:** Security
- **Where:** `src/auth.rs:225-231`, `src/auth.rs:365-415`, `src/auth.rs:431-485`
- **Problem:** The `ceremonies` SQLite table stores ceremony types as untyped text strings (`'registration'`, `'authentication'`). A mismatched finish request deletes the ceremony row and fails with `AuthError::InvalidRequest("wrong ceremony type")`, consuming a valid registration ticket without providing clear typing invariants at the boundary. Priority assumed.
- **Recommendation:** Type ceremony states explicitly in SQLite with a CHECK constraint or distinct tables, and reject mismatched ceremony kinds before row deletion.
- **Fix with:** durable-state
- **Effort:** S

### TNS-105 · P3 · Search service health combines dirty, degraded, and reconciliation into boolean triplet

- **Area:** Types
- **Where:** `crates/tansu-search/src/service.rs:17-61`, `src/search.rs:46-59`
- **Problem:** Search readiness is split across `status.dirty: bool`, `status.degraded: bool`, and `needs_reconciliation: bool` in `SearchService`, and mirrored by `SearchIndexState::Available { needs_reconciliation, degraded }`. Eight state combinations are representable, though only four are meaningful (Clean, Indexing, Degraded, NeedsRebuild). Priority assumed.
- **Recommendation:** Unify search service health into an explicit enum (`Clean | Indexing | Degraded | NeedsReconciliation`) across both crates.
- **Fix with:** make-invalid-states-unrepresentable
- **Effort:** S

### TNS-106 · P4 · Slash menu state separates position from filtered block count

- **Area:** Types
- **Where:** `web/ts/editor/slash-menu.ts:73-77`, `web/ts/editor/slash-menu.ts:101-129`
- **Problem:** `SlashState` stores `{ from: number; selected: number }` without capturing the matching blocks. Every cursor move re-evaluates the query and uses modulo arithmetic to prevent out-of-bounds selection indices if the list shrinks. Priority assumed.
- **Recommendation:** Include the current block candidate list or count directly in the active slash menu state.
- **Fix with:** make-invalid-states-unrepresentable
- **Effort:** S

### TNS-107 · P4 · PrefixedIo tracks stream handoff through raw byte buffer and offset index

- **Area:** Types
- **Where:** `src/http.rs:503-560`
- **Problem:** `PrefixedIo` manages HTTP protocol prefix replay via a `prefix: Vec<u8>` buffer and `offset: usize`. Once `offset >= prefix.len()`, the buffer is dead memory but remains allocated for the duration of the connection. Priority assumed.
- **Recommendation:** Model `PrefixedIo` state as an enum (`ReplayingPrefix { prefix, offset } | Direct(stream)`) that drops the prefix buffer once handoff to the raw stream occurs.
- **Fix with:** make-invalid-states-unrepresentable
- **Effort:** S
