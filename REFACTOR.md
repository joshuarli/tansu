# Refactor Plan

This file tracks the current TypeScript refactor work in `web/` and `packages/`.

Status keys:

- `[ ]` not started
- `[-]` in progress
- `[x]` done

## Current tranche

- [x] Recreate task tracker and turn the audit into an execution backlog
- [x] Race-proof async UI flows in `web/ts/search.ts` and `web/ts/autocomplete.ts`
- [x] Tighten the fetch/JSON boundary in `web/ts/api.ts`
- [-] Extract shared file actions used by tabs and file nav

## Backlog

### High priority

- [ ] Replace ad hoc `res.json() as T` casts with explicit decoders at API boundaries
- [ ] Remove duplicated rename/pin/delete action wiring across tabs and file nav
- [ ] Consolidate the app onto one typed event transport instead of mixing the local bus with raw `CustomEvent`
- [ ] Add a single error-reporting path for silent catches in user-important flows

### Medium priority

- [ ] Extract shared modal/listbox primitives used by search, palette, settings, and input dialog
- [ ] Replace `settings.ts` DOM scraping with a typed field schema
- [ ] Reduce stringly `innerHTML` UI assembly where structure is persistent
- [ ] Move markdown renderer/serializer/transforms toward registries instead of large condition ladders
- [ ] Trim casts in the typed event bus implementation

### Lower priority

- [ ] Name timing constants and other repeated magic numbers
- [ ] Remove small duplication like selection wrap logic between search and palette
- [ ] Clean up remaining greppability issues in command labels and helper names
