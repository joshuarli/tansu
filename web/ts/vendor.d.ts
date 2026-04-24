// fake-indexeddb's ./auto subpath has no types entry in package.json exports.
declare module "fake-indexeddb/auto";

// HTML Sanitizer API — not yet in TypeScript's lib.dom.d.ts.
interface Element {
  setHTML(html: string, options?: { sanitizer?: unknown }): void;
}
