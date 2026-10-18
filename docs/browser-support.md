# Browser support

Tansu2 supports Chrome and Safari. End-to-end coverage uses the pinned Playwright
Chromium and WebKit builds to exercise their browser engines; it does not launch
the branded Chrome or Safari applications. Browser versions are pinned in
`package.json`, and the frontend bundle targets `ESNext`. Firefox is outside the
supported browser matrix.

WebP clipboard images upload as-is. Other image types use `createImageBitmap`,
Canvas 2D, and the lazy-loaded WebP WebAssembly encoder for conversion.

Browser tests cover image-paste ordering and fixed-viewport layout. See
[Testing](testing.md) for the focused commands.
