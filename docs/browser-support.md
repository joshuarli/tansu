# Browser support

The Playwright e2e suite runs against Chromium, Firefox, and WebKit. Browser
versions are pinned in `package.json`. The frontend bundle targets `ESNext`.
The project verifies these three engines in its e2e suites. It does not publish
a compatibility guarantee for other browsers or versions.

Image paste requires `createImageBitmap` and `OffscreenCanvas`.

Run `node bench/visual-review.mjs` to inspect deterministic Chromium screenshots
at the supported desktop widths and 200% zoom. The copied fixture, generated
asset, server state, and screenshots stay under `.work/tmp/visual-review`.
