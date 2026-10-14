# Browser support

The browser e2e suite covers Chromium, Firefox, and WebKit. Browser versions are
pinned in `package.json`, and the frontend bundle targets `ESNext`. The suite
does not test other browser engines.

WebP clipboard images upload as-is. Other image types require
`createImageBitmap` and `OffscreenCanvas` for conversion to WebP.

Run `node bench/visual-review.mjs` to inspect deterministic Chromium screenshots
at the supported desktop widths and 200% zoom. The copied fixture, generated
asset, server state, and screenshots stay under `.work/tmp/visual-review`.
