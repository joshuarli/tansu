# `md-wysiwyg` Architecture

This note describes the intended internal layering of `packages/md-wysiwyg`.

## Purpose

`md-wysiwyg` is an imperative editor engine. It is responsible for:

- markdown to HTML rendering
- DOM to markdown serialization
- selection and cursor preservation
- undo/redo behavior
- block and inline editing transforms
- diff and merge helpers used by the app

It is not responsible for app workflow, tab/session state, conflict UI, SSE, or framework-specific component trees.

## Internal layers

- `markdown.ts`, `serialize.ts`, `format-ops.ts`, `transforms.ts`, and `inline-transforms.ts` hold content rules and transformations.
- `editor-renderer.ts` owns HTML writes into the contenteditable surface.
- `editor-selection.ts` owns markdown offset tracking plus DOM selection restoration.
- `editor-undo.ts` owns undo/redo history and typing checkpoints.
- `editor-transactions.ts` owns markdown-level selection edits such as format and paste commits.
- `editor.ts` should stay the orchestration layer that wires those pieces into a single browser editor handle.

The intent is to keep `editor.ts` as the application layer for the editor engine, not a dumping ground for every low-level concern.

## Why it stays imperative

The hot path here is browser editing behavior:

- `contenteditable`
- DOM selection/range handling
- clipboard and image paste
- cursor restoration after full rerender
- undo boundaries that need to cooperate with live DOM state

Those are browser integration problems first. A framework reconciler can sit above this package, but it should not replace the core engine unless profiling shows a clear win.

## Performance rule

Do not pursue incremental DOM patching or a framework rewrite without measurement.

Use the opt-in large-note benchmark first:

```sh
MD_WYSIWYG_BENCH=1 pnpm vitest run packages/md-wysiwyg/tests/large-note-bench.test.ts
```

That benchmark is meant to give a baseline for:

- markdown render time
- DOM to markdown serialization time
- editor `setValue()` time
- editor `getValue()` time

If those numbers are acceptable for realistic note sizes, prefer simpler full-render paths over more complex incremental machinery.
