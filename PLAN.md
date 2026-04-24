# Plan: Source-text formatting and undo/redo

## Goal

The DOM is a rendered view only. Nothing writes to `contentEl` except the renderer
(`contentEl.innerHTML = renderMarkdown(...)`). All formatting operations are pure
transformations on the markdown source string, followed by a re-render that restores
the selection. Undo/redo is an explicit stack of markdown snapshots, entirely
independent of the browser's DOM undo mechanism and of autosave.

---

## Step 1: `renderMarkdownWithSelection` in `packages/md-wysiwyg`

**Files:** `src/markdown.ts`, `src/index.ts`, new test file

Add two new private-use sentinels alongside the existing cursor sentinel:

```
SEL_START_SENTINEL = '﷑'
SEL_END_SENTINEL   = '﷒'
```

The renderer already handles `﷐` → `<span data-md-cursor="true">`. Extend it
to emit:

- `﷑` → `<span data-md-sel-start="true"></span>`
- `﷒` → `<span data-md-sel-end="true"></span>`

New export:

```ts
export function renderMarkdownWithSelection(
  src: string,
  selStart: number,
  selEnd: number,
): string
```

Injects the two sentinels at `selStart` and `selEnd` in the markdown string (clamped,
`selEnd >= selStart`), then calls `renderMarkdown` on the modified string.

Also export a `restoreSelectionFromMarkers(contentEl: HTMLElement): void` helper (can
live in editor.ts or the package) that:
1. Finds `[data-md-sel-start]` and `[data-md-sel-end]` spans
2. Creates a Range from `startAfter(selStartSpan)` to `startBefore(selEndSpan)`
3. Applies it via `sel.removeAllRanges() / sel.addRange(r)`
4. Removes both spans

Add tests covering: collapsed selection (selStart === selEnd), selection spanning inline
marks, selection spanning block boundaries.

---

## Step 2: `getSelectionMarkdownOffsets` helper

**File:** `web/ts/editor.ts` (or a new `web/ts/selection.ts`)

`getCursorMarkdownOffset` temporarily mutates the DOM (inserts a sentinel span, then
removes it). Calling it twice sequentially for start and end is unsafe: the first
call's `normalize()` may merge or split text nodes, invalidating the second call's
saved container reference.

Instead, write a single-pass helper that inserts **both** markers before serializing:

```ts
function getSelectionMarkdownOffsets(
  contentEl: HTMLElement,
): { start: number; end: number } | null
```

Implementation:
1. Get `sel = window.getSelection()`. Return null if no range or collapsed.
2. Insert `[data-md-sel-start]` span at `range.startContainer / startOffset`.
3. Insert `[data-md-sel-end]` span at `range.endContainer / endOffset`.
4. Call `domToMarkdown(contentEl)`. Find positions of both sentinels.
5. Remove both spans, call `normalize()` once, restore the original range.
6. Return `{ start, end }`.

---

## Step 3: Pure source-text inline format operations

**File:** `web/ts/format-ops.ts` (new file)

Each function is pure: takes the full markdown string and selection offsets, returns
the transformed markdown and updated offsets. No DOM access.

```ts
type FormatResult = { md: string; selStart: number; selEnd: number };

export function toggleBold(md: string, start: number, end: number): FormatResult
export function toggleItalic(md: string, start: number, end: number): FormatResult
export function toggleStrikethrough(md: string, start: number, end: number): FormatResult
export function toggleHighlight(md: string, start: number, end: number): FormatResult
export function clearInlineFormats(md: string, start: number, end: number): FormatResult
```

**Toggle logic** (same pattern for each marker pair):

For a marker of length `n` (e.g. `**` → n=2):
- Already wrapped: `md.slice(start-n, start) === marker && md.slice(end, end+n) === marker`
  → Remove outer markers. New offsets shift left by `n`.
- Not wrapped: insert marker at `start` and `end`.
  → New `selStart = start + n`, `selEnd = end + n`.

`clearInlineFormats`: operates only on `md.slice(start, end)`. Strip all occurrences
of `**`, `*`, `~~`, `==`, `` ` `` using a regex replace on that slice. Adjust `end`
by the number of characters removed. `selStart` stays at `start`.

**Important edge case**: italic (`*`) conflicts with bold (`**`). Always check for `**`
before `*` when detecting.

Add comprehensive tests in `web/ts/format-ops.test.ts` covering: toggle on, toggle off,
already partially formatted, selection at document boundaries, `clearInlineFormats`
with mixed markers.

---

## Step 4: Pure source-text block format operations

**File:** `web/ts/format-ops.ts`

```ts
export function toggleHeading(md: string, selStart: number, level: 1|2|3|4|5|6): FormatResult
export function toggleCodeFence(md: string, selStart: number, selEnd: number): FormatResult
```

**`toggleHeading`**: find the line containing `selStart`. If it already starts with the
same `#{level} `, strip the prefix; otherwise replace any existing heading prefix (or
none) with `#{level} `. Adjust `selStart`/`selEnd` by the prefix length delta.

**`toggleCodeFence`**: find the lines containing `selStart` and `selEnd`. If the
surrounding lines are already ` ``` ` fences, remove them; otherwise wrap with
`\`\`\`\n...\n\`\`\``. Adjust offsets accordingly.

Add tests.

---

## Step 5: Pure source-text indent/dedent

**File:** `web/ts/format-ops.ts`

```ts
export function shiftIndent(
  md: string,
  selStart: number,
  selEnd: number,
  dedent: boolean,
): FormatResult
```

Find all lines that overlap `[selStart, selEnd]`. Add or remove one leading `\t` from
each. Return updated markdown and recalculated offsets (each added `\t` shifts
downstream offsets by 1; removed `\t` shifts back by 1, clamped so offsets don't go
before the line start).

---

## Step 6: Wire format ops into the toolbar and keyboard shortcuts

**Files:** `web/ts/format-toolbar.ts`, `web/ts/editor.ts`

Replace every format action in `populateFormatButtons` and every keyboard shortcut
(`Cmd+B`, `Cmd+I`, `Cmd+H`, `Tab`) with the source-text pattern:

```ts
function applyInlineFormat(transform: (md, s, e) => FormatResult) {
  if (!contentEl) return;
  const sel = getSelectionMarkdownOffsets(contentEl);
  if (!sel) return;
  const md = domToMarkdown(contentEl);
  const { md: newMd, selStart, selEnd } = transform(md, sel.start, sel.end);
  pushUndo(md, sel.start, sel.end);          // step 7
  contentEl.innerHTML = renderMarkdownWithSelection(newMd, selStart, selEnd);
  restoreSelectionFromMarkers(contentEl);
  onMutation();
}
```

Block ops (headings, code fence, indent) follow the same shape but use
`getSelectionMarkdownOffsets` for line context.

After this step, `document.execCommand` is no longer called by any format action.
`toggleInlineWrap`, `applyBlockFormat`, `applyCodeBlock`, `clearInlineStyles`, and
`applyHighlightToSelection` are deleted.

---

## Step 7: Custom undo/redo stack

**File:** `web/ts/editor.ts`

The browser DOM undo stack is unreliable once any code sets `innerHTML` directly
(which all re-renders do). Replace it with an explicit stack.

**Data structure:**

```ts
type UndoEntry = { md: string; selStart: number; selEnd: number };
let undoStack: UndoEntry[] = [];
let undoIndex = -1;          // points to the current position in the stack
```

**`pushUndo(md, selStart, selEnd)`**: called before every mutation (format op, block
transform, indent). Truncates any redo tail (`undoStack.splice(undoIndex + 1)`), appends
the entry, advances `undoIndex`. Cap stack depth at ~200 entries.

**`snapshotForTyping()`**: a debounced (1 s) snapshot push that groups consecutive
keystrokes into a single undo step. Called from the `input` event handler for
non-structural edits (plain typing).

**`undo()`**:
1. If `undoIndex <= 0`, nothing to undo.
2. Snapshot current state at `undoIndex` if it hasn't been snapshotted yet (the
   "live" state is the current DOM; convert with `domToMarkdown` + current selection).
3. Decrement `undoIndex`. Load `undoStack[undoIndex]`.
4. `contentEl.innerHTML = renderMarkdownWithSelection(entry.md, entry.selStart, entry.selEnd)`
5. `restoreSelectionFromMarkers(contentEl)`.
6. Call `onMutation()` — content changed, autosave should see this.

**`redo()`**: advance `undoIndex`, same re-render path.

**Keyboard interception** in the `keydown` handler:
```
Cmd+Z / Ctrl+Z           → e.preventDefault(); undo()
Cmd+Shift+Z / Ctrl+Y     → e.preventDefault(); redo()
```

Remove the `historyUndo` / `historyRedo` branches from the `input` handler — they
cannot fire once `e.preventDefault()` suppresses browser undo.

**Stack initialization**: `pushUndo` with the initial markdown when `showEditor` runs.
Clear stack (`undoStack = []; undoIndex = -1`) in `hideEditor`.

---

## Step 8: Decouple autosave from undo

**File:** `web/ts/editor.ts`

Currently, `markDirty` and `scheduleAutosave` fire on undo/redo steps, which is
semantically correct (the content changed) but mixes two concerns conceptually. After
step 7, undo/redo call `onMutation()`, which already calls `markDirty` and
`scheduleAutosave`. No change is needed there.

The real fix is that autosave should never write to the DOM and never interact with the
undo stack. Verify this invariant holds: `_doSave` only reads `getCurrentContent()` and
`saveCursorOffset()` — both are pure reads. Autosave's `setCursor` writes to tab state
(not the DOM). This is already correct; just document the invariant explicitly.

One concrete improvement: replace the `dirty` boolean flag in tab state with a content
comparison — `isDirty = currentMd !== lastSavedMd` — so undoing back to the last-saved
state automatically shows the tab as clean without a separate `markClean` call needed.
This requires storing `lastSavedMd` alongside `lastSavedMtime`.

---

## Step 9: Migrate block input transforms (deferred)

**File:** `packages/md-wysiwyg/src/transforms.ts`

`handleBlockTransform` (Enter key) and `checkBlockInputTransform` (Space key) currently
use `execCommand("insertHTML")` to participate in the browser undo stack, and
`setCursorStart` manipulates the DOM directly.

Once the custom undo stack is in place (step 7), these can be migrated to the same
source-text + re-render pattern:

1. Before transform: `pushUndo(domToMarkdown(contentEl), ...)`.
2. Compute the new markdown string for the transform (pure function, no DOM).
3. `contentEl.innerHTML = renderMarkdownWithSelection(newMd, newCursorPos, newCursorPos)`.
4. `restoreSelectionFromMarkers(contentEl)`.

This removes all `execCommand` usage from the codebase. `transforms.ts` becomes a
set of pure markdown string functions.

This step touches the `md-wysiwyg` package API and should be done separately after
steps 1–8 are stable and tested.

---

## Step 10: Cleanup

Remove once all steps above are done:

- `document.execCommand` calls (bold, italic, formatBlock, insertHTML) — should be zero
- `toggleInlineWrap`, `applyBlockFormat`, `applyCodeBlock`, `clearInlineStyles` in `format-toolbar.ts`
- `applyHighlightToSelection` in `editor.ts`
- `indentCurrentSelection` DOM implementation in `editor.ts` (replaced by `shiftIndent`)
- `getDirectChild`, `nodeIsInsideTag`, `TOOLBAR_BLOCK_TAGS` helpers
- `STRIP_TAGS` constant
- The `historyUndo` / `historyRedo` input-event branches

At this point `format-toolbar.ts` contains only: `populateFormatButtons`, `initFormatToolbar`,
and `positionToolbar`. All format logic lives in `format-ops.ts` (pure functions).

---

## What is not changing

- `domToMarkdown` — already correct, no changes
- `getCursorMarkdownOffset` — kept for the single-cursor path (`loadContent`, save)
- `renderMarkdown` / `renderMarkdownWithCursor` — kept for load and single-cursor restore
- The autosave mechanism and timing
- The `populateFormatButtons` / `initFormatToolbar` split (toolbar structure is fine)
- Block input transforms in `transforms.ts` until step 9
