# Tansu2 TODO

Prefix: TNS
Next: 54

### TNS-045 · P3 · Bound and stabilize asset prefetch

- **Area:** Performance
- **Where:** `web/ts/app.ts:1857`
- **Problem:** `prefetchAssets()` loads assets one at a time and reconfigures the editor after each, and the cache is cleared on every tab switch. Image-heavy notes load slowly and reconfigure the editor repeatedly. Unmeasured.
- **Recommendation:** Load with bounded concurrency, visible images first, batch the editor reconfiguration, and keep a cache stable across tab switches. Keep the abort and object-URL cleanup discipline, with a leak check from TNS-048.
- **Fix with:** make-it-fast
- **Effort:** M

### TNS-050 · P3 · Move document state into a per-document controller

- **Area:** Architecture
- **Where:** `web/ts/app.ts`
- **Problem:** Editor state, the dirty snapshot, the journal, and in-flight mutations live in the app and follow the active tab. Lifecycle bugs (tab close, tab switch, delayed responses) recur because nothing owns a document's state independent of tab activity.
- **Recommendation:** Write the RFC, then extract a document controller one boundary at a time while fixing lifecycle bugs. No sweeping file split.
- **Fix with:** api-surface-and-module-boundaries
- **Design:** `docs/rfcs/TNS-050-document-controller.md`
- **Effort:** L
