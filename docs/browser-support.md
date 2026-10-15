# Browser support

Tansu2 supports Chrome and Safari. End-to-end coverage uses the pinned Playwright
Chromium and WebKit builds to exercise their browser engines; it does not launch
the branded Chrome or Safari applications. Browser versions are pinned in
`package.json`, and the frontend bundle targets `ESNext`. Firefox is outside the
supported browser matrix.

WebP clipboard images upload as-is. Other image types use `createImageBitmap`,
Canvas 2D, and the lazy-loaded WebP WebAssembly encoder for conversion.

Run `node bench/visual-review.mjs` to inspect deterministic Chromium screenshots
at the supported desktop widths and 200% zoom. The copied fixture, generated
asset, server state, and screenshots stay under `.work/tmp/visual-review`.
