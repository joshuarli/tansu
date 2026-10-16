# TNS-050: Per-document controller

Status: accepted

## Summary

A document controller owns one open note's editor state, dirty snapshot, journal, and in-flight mutations, independent of which tab is active.

## Motivation

These live in the app and follow tab activity. Closing or switching a tab while a save, restore, or asset load is in flight has produced lifecycle defects, and the fixes so far are local patches in `web/ts/app.ts`. See TNS-049 for the async ownership rule this design would make structural.

## Design

Extract boundaries incrementally, each alongside a lifecycle fix:

1. The controller holds the editor state, dirty snapshot, journal, and the set of in-flight mutations for one note, keyed by `noteId`.
2. Tabs reference controllers; closing a tab asks the controller to flush or discard, and the controller outlives the tab until its mutations settle.
3. Async completions are delivered to the controller that issued them, with the vault identity captured at issue time.

No sweeping file split. Editor behavior stays inside `web/ts/editor/`.

## Alternatives considered

- Keep patching `app.ts` per bug: lowest cost, but the ownership gap stays.
- Full rewrite of app state: too large to verify against the save and recovery invariants.

## Open questions

- Does the controller own the editor view, or only its state? Decision: only state. The editor handle and its per-tab `EditorSession` stay with the app and `web/ts/editor/`; the controller will reference an editor session only through a narrow interface, never the view.
- Where does the journal persist across a reload? Decision: unchanged. The `DraftJournal` writes checkpoints to IndexedDB through `workspace-store.ts`, keyed by workspace and note identity, and `getDraftCheckpoint` recovers them on load. The `JournalHandle` owns only the in-memory journal object and its listener, one per app instance, not per note.
- Which existing tests become controller tests? Decision: the load dedupe, autosave timer, and session subscription cases live in `document-controller.test.ts`, and the draft journal lifecycle in `journal-handle.test.ts`. Tests that need the DOM and editor (stale load completions, tab close during load) stay in `app.test.ts`.

## Decision

Accepted. Extraction proceeds one boundary at a time.

Done:

- `DocumentControllers` in `web/ts/app/document-controller.ts` owns the per-note load dedupe and autosave timer. Closing a tab releases its controller.
- `dirtySnapshot` in the same file projects a `DocumentSessionState` into the tab's draft, dirty, saving, conflict, title, and path fields. `DocumentController.attachSession` owns the one session subscription per note, replaces the previous subscription, and `release` and `disposeAll` unsubscribe it.
- `JournalHandle` in `web/ts/app/journal-handle.ts` owns the lazily created draft journal and its visibility-flush attachment. `dispose` flushes, detaches, and makes later `get` calls throw, so a load that outlives `dispose` can no longer create a journal and listener nobody detaches; `loadSavedTab` and `loadLocalDraft` return early once disposed. The duplicated session service wiring in `loadSavedTab` and `createDocumentSession` is one `documentSessionServices`.
- `loadSavedTab` checks every completion (cache read, network body, failure) with one `isLoadCurrent` that compares the session, the tab, and the vault identity and client captured when the load was issued. `app.test.ts` covers a body or failure arriving after the vault switched or the tab closed.

Not done:

- The editor session and the in-flight mutation set (saves, restores, asset loads) still live on the tab and the app, so closing a tab does not yet make the controller outlive it until mutations settle. Next: move the in-flight save and restore promises into the controller, then let `closeTab` ask the controller to flush or discard.
- `loadLocalDraft` and `createDocumentSession` still repeat their own currency checks inline.
