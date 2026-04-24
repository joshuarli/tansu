# Refactor Checklist

Items are grouped by severity and ordered by suggested priority.

## Low — style / minor

- [ ] **L1** — magic timing numbers throughout: autosave `1500ms`/`500ms` (`editor.ts:297,306`), typing snapshot `1000ms` (`editor.ts:872`), SSE retry sequence (`main.ts:342`), notification `5000ms` (`main.ts:333`), tooltip hide `100ms` (`link-hover.ts:32`), image resize min `50`/factor `1.5` (`image-resize.ts:20`), undo stack size `200` (`editor.ts:853`); name them
- [ ] **L2** `palette.ts:188` — shortcut strings use raw unicode escapes (`"⌘K"`); not greppable as "Cmd+K"
- [ ] **L4** `image-paste.ts:19` — manual `YYYYMMDDhhmmss` date formatting; use `.toISOString().replaceAll(/[-T:]/g, "").slice(0, 14)`
- [ ] **L5** `filenav.ts:238 timeAgo` vs `util.ts:9 relativeTime` — two time-ago formatters with different outputs and thresholds; pick one
- [ ] **L6** `wrapIndex` pattern duplicated in `palette.ts:126` and `search.ts:87`; extract helper
- [ ] **L7** `markdown.ts:228` — `(block satisfies never, "")` abuses comma operator; use `_exhaustiveCheck(block); return ""`
- [ ] **L8** `conflict.ts` — `loadContent`/`getCurrentContent` callback shapes repeated across multiple signatures; extract a `ContentIO` type
- [ ] **L9** `revisions.ts:62–64` — hardcoded color `#57606a` in inline styles; use a CSS variable or class
- [ ] **L11** `md-wysiwyg/src/index.ts` — package barrel leaks internal implementation details (`matchPattern`, `computeReplaceRange`, `buildReplacementHtml`); trim to the public API
