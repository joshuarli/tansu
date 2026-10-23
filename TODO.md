# Tansu TODO

Prefix: TNS
Next: 84

## Next

### TNS-083 · P3 · Investigate the intermittent app boot fixture failure

- **Area:** Tests
- **Where:** `web/ts/app.test.ts`, `web/ts/document-session.test.ts`, `web/ts/view.test.ts`
- **Problem:** One three-file run at seed `1792771486558` reached the closing-save/reopen test after `app.boot()` without creating the expected editor. A later broad Vitest run at seed `1792778081422` also failed `document controller outlives its tab > waits for a pending rename before reopening the note` with `editorMock.instances[0]` undefined; it was not isolated in a rerun. The isolated test, exact rerun, five app-only runs, and final 198-test group passed for the first occurrence. The cause remains unproven; passing retries do not establish a fix.
- **Recommendation:** Capture boot completion and pending fixture work when the editor is absent, then reproduce and remove the shared-state or lifecycle cause. Keep the closing-save assertions intact.
- **Fix with:** root-cause
- **Effort:** S
