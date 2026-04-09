# Plan: Extract WYSIWYG Editor as a Standalone TypeScript Package

## Final decisions

| Decision                                 | Choice                                                                    |
| ---------------------------------------- | ------------------------------------------------------------------------- |
| Location                                 | `packages/md-wysiwyg/` in this repo                                       |
| Package name                             | `@tansu/md-wysiwyg`                                                       |
| Import path                              | Bun workspace + package name                                              |
| Existing web/ts/ tests for moved modules | Deleted — tests live only in the package                                  |
| transforms.ts decoupling                 | `onDirty?: () => void` callback param; `web/ts/` gets a thin adapter shim |

---

## Dependency analysis

### Files that move into the package (pure WYSIWYG concerns)

| File                   | Role                                    | Coupling issues                                              |
| ---------------------- | --------------------------------------- | ------------------------------------------------------------ |
| `markdown.ts`          | Markdown → HTML renderer                | imports `highlight.ts`, `util.ts` — both move                |
| `highlight.ts`         | Syntax highlighter (wraps highlight.js) | imports `util.ts` — moves                                    |
| `serialize.ts`         | DOM → Markdown serializer               | no tansu deps                                                |
| `transforms.ts`        | Block-level input transforms            | imports `markDirty` from `tabs.ts` — **fixed with callback** |
| `inline-transforms.ts` | Inline pattern transforms               | no tansu deps                                                |
| `diff.ts`              | Line diff algorithm + HTML renderer     | imports `util.ts` — moves                                    |
| `merge.ts`             | 3-way line merge                        | no tansu deps                                                |
| `util.ts` (subset)     | `escapeHtml`, `stemFromPath`            | `debounce`/`relativeTime` stay in `web/ts/util.ts`           |

### Files that stay in `web/ts/` (tansu-specific)

`api.ts`, `tabs.ts`, `tab-state.ts`, `autocomplete.ts`, `backlinks.ts`, `conflict.ts`, `revisions.ts`, `image-paste.ts`, `events.ts`, `editor.ts`, `search.ts`, `settings.ts`, `palette.ts`, `webauthn.ts`, `wikilinks.ts`, `main.ts`, and `util.ts` (trimmed to `debounce` + `relativeTime`).

---

## Package structure

```
packages/md-wysiwyg/
  package.json
  tsconfig.json
  src/
    index.ts               # public re-exports
    markdown.ts
    highlight.ts
    serialize.ts
    transforms.ts          # onDirty callback replaces markDirty import
    inline-transforms.ts
    diff.ts
    merge.ts
    util.ts                # escapeHtml + stemFromPath only
  tests/
    test-helper.ts         # setupDOM() only — no MockBody/mockFetch
    markdown.test.ts
    serialize.test.ts
    transforms.test.ts     # updated: passes onDirty callback directly
    inline-transforms.test.ts
    diff.test.ts
    merge.test.ts
    roundtrip.test.ts
```

### `packages/md-wysiwyg/package.json`

```json
{
  "name": "@tansu/md-wysiwyg",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "test": "bun test tests/*.test.ts"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "happy-dom": "^20.8.9"
  }
}
```

`private: true` — consumed via workspace link, not published.

### `packages/md-wysiwyg/tsconfig.json`

```json
{
  "extends": "../../tsconfig.json",
  "include": ["src", "tests"]
}
```

Extends root so all strict compiler options stay in sync automatically.

---

## `packages/md-wysiwyg/src/index.ts`

```ts
export { renderMarkdown } from "./markdown.ts";
export { highlightCode } from "./highlight.ts";
export { domToMarkdown } from "./serialize.ts";
export { handleBlockTransform } from "./transforms.ts";
export { checkInlineTransform } from "./inline-transforms.ts";
export type { InlinePattern } from "./inline-transforms.ts";
export { computeDiff, renderDiff } from "./diff.ts";
export type { DiffHunk, DiffLine } from "./diff.ts";
export { merge3 } from "./merge.ts";
export { escapeHtml, stemFromPath } from "./util.ts";
```

---

## The `transforms.ts` API change

**Before** (in `web/ts/transforms.ts`):

```ts
import { markDirty } from "./tabs.ts";

export function handleBlockTransform(
  e: KeyboardEvent,
  contentEl: HTMLElement,
  currentPath: string | null,
): void {
  // ... on transform:
  if (currentPath) markDirty(currentPath);
}
```

**After** (in `packages/md-wysiwyg/src/transforms.ts`):

```ts
export function handleBlockTransform(
  e: KeyboardEvent,
  contentEl: HTMLElement,
  onDirty?: () => void,
): void {
  // ... on transform:
  onDirty?.();
}
```

**Adapter shim** at `web/ts/transforms.ts` (replaces the original file entirely):

```ts
export { handleBlockTransform as _handleBlockTransform } from "@tansu/md-wysiwyg";
import { handleBlockTransform as _handleBlockTransform } from "@tansu/md-wysiwyg";
import { markDirty } from "./tabs.ts";

export function handleBlockTransform(
  e: KeyboardEvent,
  contentEl: HTMLElement,
  currentPath: string | null,
): void {
  _handleBlockTransform(e, contentEl, currentPath ? () => markDirty(currentPath) : undefined);
}
```

`editor.ts` and all other tansu callers of `handleBlockTransform` import from `./transforms.ts` as before — the shim preserves the original signature exactly, so no callers change.

---

## Root-level config changes

### `package.json`

Add `workspaces` and update `scripts.test` to cover both test suites:

```json
{
  "name": "tansu",
  "private": true,
  "type": "module",
  "workspaces": ["packages/md-wysiwyg"],
  "scripts": {
    "test": "bun test web/ts/*.test.ts packages/md-wysiwyg/tests/*.test.ts"
  },
  "devDependencies": { ... }
}
```

### `tsconfig.json`

Add `paths` alias so `bunx tsgo --noEmit` resolves `@tansu/md-wysiwyg` to local source, and expand `include`:

```json
{
  "compilerOptions": {
    ...
    "paths": {
      "@tansu/md-wysiwyg": ["./packages/md-wysiwyg/src/index.ts"]
    }
  },
  "include": ["web/ts", "packages/md-wysiwyg/src", "packages/md-wysiwyg/tests"]
}
```

Bun's bundler resolves `@tansu/md-wysiwyg` at build time via the workspace symlink in `node_modules/`; the `paths` entry is only for `tsgo` type-checking.

### `Makefile`

Update `test-ts` target:

```makefile
test-ts:
	bun test web/ts/*.test.ts packages/md-wysiwyg/tests/*.test.ts
```

### `bunfig.toml`

The `coveragePathIgnorePatterns` currently lists `web/ts/webauthn.ts` and `web/ts/e2e/`. No changes needed — package tests are picked up automatically. Coverage threshold is 92%; all moved code already has thorough test coverage so this should hold.

---

## `web/ts/util.ts` — handling the split

`util.ts` currently exports `debounce`, `escapeHtml`, `relativeTime`, `stemFromPath`. After extraction:

- `escapeHtml` and `stemFromPath` live in the package (`packages/md-wysiwyg/src/util.ts`).
- `debounce` and `relativeTime` remain in `web/ts/util.ts`.
- Every `web/ts/` file that imports `escapeHtml`/`stemFromPath` from `./util.ts` is updated to import from `@tansu/md-wysiwyg` instead.
- No shim in `web/ts/util.ts` for these — callers are updated at the import site directly.

---

## Files deleted from `web/ts/` after extraction

**Source files** (functionality now comes from package imports):

- `web/ts/markdown.ts`
- `web/ts/highlight.ts`
- `web/ts/serialize.ts`
- `web/ts/inline-transforms.ts`
- `web/ts/diff.ts`
- `web/ts/merge.ts`
- `web/ts/transforms.ts` → replaced by the adapter shim (same filename, new content — not deleted)

**Test files** (migrated into package):

- `web/ts/markdown.test.ts`
- `web/ts/serialize.test.ts`
- `web/ts/transforms.test.ts`
- `web/ts/inline-transforms.test.ts`
- `web/ts/diff.test.ts`
- `web/ts/merge.test.ts`
- `web/ts/roundtrip.test.ts`

---

## Step-by-step implementation sequence

1. Create `packages/md-wysiwyg/` with `package.json` and `tsconfig.json` as specified above.
2. Copy `markdown.ts`, `highlight.ts`, `serialize.ts`, `inline-transforms.ts`, `diff.ts`, `merge.ts` verbatim into `packages/md-wysiwyg/src/`. Internal imports (`./util.ts`, `./highlight.ts`) resolve correctly within the package — no path changes.
3. Write `packages/md-wysiwyg/src/util.ts` with just `escapeHtml` and `stemFromPath` (extracted from `web/ts/util.ts`).
4. Copy `web/ts/transforms.ts` into `packages/md-wysiwyg/src/transforms.ts` and apply the `onDirty` callback change (remove `markDirty` import, replace the call site with `onDirty?.()`).
5. Write `packages/md-wysiwyg/src/index.ts`.
6. Copy test files into `packages/md-wysiwyg/tests/`. Write a minimal `test-helper.ts` (just `setupDOM()` from `happy-dom` — no `MockBody`/`mockFetch`/tansu API types). Update `transforms.test.ts` to pass an `onDirty` spy directly instead of mocking tabs.
7. Add `"workspaces": ["packages/md-wysiwyg"]` to root `package.json`; update `scripts.test`.
8. Add `paths` alias and expand `include` in root `tsconfig.json`.
9. Run `bun install` to create the workspace symlink at `node_modules/@tansu/md-wysiwyg`.
10. Update every `web/ts/` file that imports from the moved modules to import from `@tansu/md-wysiwyg`. Update callers of `escapeHtml`/`stemFromPath` to import from `@tansu/md-wysiwyg` instead of `./util.ts`.
11. Replace `web/ts/transforms.ts` with the adapter shim.
12. Remove `escapeHtml` and `stemFromPath` from `web/ts/util.ts`.
13. Delete the moved source files and migrated test files from `web/ts/`.
14. Update `Makefile` `test-ts` target.
15. Run `bunx tsgo --noEmit` — fix any type errors.
16. Run `bun test web/ts/*.test.ts packages/md-wysiwyg/tests/*.test.ts` — all tests pass.
17. Run `bun build web/ts/main.ts --outfile web/static/app.js --minify` — bundle builds cleanly.

---

## Scope boundary

The package ships only editor primitives. Deliberately excluded (remain in tansu):

- Autocomplete (requires note-list fetch)
- Image paste (requires upload endpoint)
- Backlinks, revisions, conflict resolution
- Tab/dirty state management
- The event bus
- `editor.ts` (the orchestrator)

A second consumer wires these up via callbacks — `onDirty` now, and in the future potentially `onImagePaste`, `onWikiLinkInserted`. The package's API surface is stable without requiring knowledge of tansu's architecture.
