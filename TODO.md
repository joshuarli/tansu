This file tracks the current TypeScript refactor work in `web/` and `packages/`.

### High priority

- [ ] Remove duplicated rename/pin/delete action wiring across tabs and file nav
- [ ] Consolidate the app onto one typed event transport instead of mixing the local bus with raw `CustomEvent`
- [ ] Add a single error-reporting path for silent catches in user-important flows

### Medium priority

- [ ] Extract shared modal/listbox primitives used by search, palette, settings, and input dialog
- [ ] Replace `settings.ts` DOM scraping with a typed field schema
- [ ] Reduce stringly `innerHTML` UI assembly where structure is persistent
- [ ] Move markdown renderer/serializer/transforms toward registries instead of large condition ladders
- [ ] Trim casts in the typed event bus implementation
