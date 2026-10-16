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

- Does the controller own the editor view, or only its state?
- Where does the journal persist across a reload?
- Which existing tests become controller tests?

## Decision

Accepted. Extraction proceeds one boundary at a time.

Done:

- `DocumentControllers` in `web/ts/app/document-controller.ts` owns the per-note load dedupe and autosave timer. Closing a tab releases its controller.
- `dirtySnapshot` in the same file projects a `DocumentSessionState` into the tab's draft, dirty, saving, conflict, title, and path fields. `DocumentController.attachSession` owns the one session subscription per note, replaces the previous subscription, and `release` and `disposeAll` unsubscribe it.

Next boundaries, in order: the journal handle, then stale-completion checks in `loadSavedTab`.
