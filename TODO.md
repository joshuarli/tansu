# Tansu2 TODO

Prefix: TNS
Next: 24

### TNS-21 · P3 · Show the note title in the note canvas

- **Area:** Navigability
- **Where:** `web/ts/view.ts:382`, `web/ts/view.ts:429`
- **Problem:** The tab shows the note title, but the canvas begins with the body editor. The reader loses the note title when focusing on its content.
- **Recommendation:** Render the existing note title above the body in the canvas. Read it from note metadata, not Markdown content.
- **Fix with:** none
- **Effort:** S (hours)

### TNS-22 · P3 · Remove the sidebar and float its remaining controls

- **Area:** Navigability
- **Where:** `web/ts/view.ts:213`, `web/ts/view.ts:300`, `web/ts/view.ts:332`, `web/ts/view.ts:429`, `web/static/app.css:71`
- **Problem:** The sidebar uses a fixed column for the vault picker, note outline, recent and pinned lists, search, and note actions. The requested layout has no sidebar, so these controls need new positions.
- **Recommendation:** Remove the sidebar UI, place New Note beside the tabs, show “On this note” in a floating outline, and shrink the vault picker into a floating control at the lower left.
- **Fix with:** none
- **Effort:** M (days)

### TNS-23 · P3 · Open search on recent notes and filter as you type

- **Area:** Navigability
- **Where:** `web/ts/app.ts:279`, `web/ts/app.ts:1505`, `web/ts/app.ts:1539`, `web/ts/view.ts:640`, `web/ts/view.ts:676`
- **Problem:** Search opens with an empty query and shows prior searches. Quick Open shows recent notes in a separate overlay. The user cannot open Search with `/`.
- **Recommendation:** Bind `/` to Search. Show recent notes while the query is empty, then show live search matches when typing starts.
- **Fix with:** none
- **Effort:** M (days)
