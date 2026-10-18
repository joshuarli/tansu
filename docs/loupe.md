# Loupe

Loupe is a Chromium Manifest V3 reader extension. Its toolbar button opens or hides a reader overlay on the current page.

## Reader

The content script sends the page HTML and URL to the service worker when extraction starts. The worker calls the `defuddle-rs` WebAssembly adapter.

The reader renders extracted HTML inside a Shadow DOM. It keeps the result only while the page URL stays unchanged. Extraction errors restore the page's scroll styles and show a dismissible message.

Readers can select extractors and copy extracted HTML or Markdown with YAML frontmatter. They can also open Markdown in Obsidian or send it to Tansu. Date-only publication metadata keeps its calendar day.

The Obsidian action copies Markdown before opening its URI. If clipboard access fails, the URI carries the Markdown content.

The [reader markup](../extension-loupe/src/reader-overlay.html) and [stylesheet](../extension-loupe/src/reader-overlay.css) load into the Shadow DOM. The [fixture serializer](../extension-loupe/src/reader-fixture.ts) captures browser-rendered content with inline CSS.

## Sending to Tansu

The reader menu and the `send-to-tansu` keyboard command use the same import flow. The command defaults to Ctrl+Shift+S, or Command+Shift+S on macOS.

The command extracts the active tab without opening the reader. It reports progress in a shadow-DOM toast. If the user has not set a Tansu URL, Loupe opens its options page.

The [options page](../extension-loupe/src/options.html) stores one setting in `chrome.storage.local`. It normalizes the value to an HTTP or HTTPS origin and validates it with [Schema](../extension-loupe/src/tansu-schemas.ts).

The service worker validates each request, prepares image data, and calls the Tansu page API in [one Effect program](../extension-loupe/src/tansu-send.ts):

1. Loupe replaces standard remote Markdown image embeds with `tansu-import-image:ID` placeholders. It fetches image bytes from the service worker in [tansu-import.ts](../extension-loupe/src/tansu-import.ts).
2. Four image requests run at once. Retries use exponential backoff for status codes 408, 425, 429, and 5xx.
3. Only HTTP or HTTPS URLs with an `image/*` content type qualify. Each image is limited to 10 MB. The total is limited to 40 MB in source order.
4. Failed and oversized images stay remote. Tansu receives their original URL with `base64: null`.
5. Loupe reuses an open Tansu tab or opens one in the background. It waits for page load and injects the classic `tansu-import-page.js` script.
6. Loupe waits three seconds for `import.ready`. If Tansu is not ready, Loupe activates the tab and waits up to three minutes total.
7. Loupe posts the import request and waits up to two minutes for its matching result. The reader shows the result and offers an action to focus the Tansu tab.

The service worker pings an extension API every 20 seconds while an import runs. This keeps it alive during the five-minute worst case.

## Protocol

Loupe and Tansu exchange same-origin `window.postMessage` messages. Each message uses `channel: "tansu"` and `version: 1`.

Both sides ignore messages from another window or origin. Tansu sends `import.ready` when it can accept an import. It also answers Loupe's `import.ping` messages.

Loupe sends `import.request` with a request ID, title, Markdown, source URL, and image records. Each image record contains its ID, URL, content type, and base64 bytes or `null`.

Tansu replies with `import.result` and the matching request ID. Success includes the note ID, path, localized image count, and failed image count. Failure includes an error message.

Tansu converts images to WebP and uploads them. Loupe only fetches the source bytes. The bytes cross `executeScript` as base64.

Chrome drops `null` properties from `executeScript` arguments. Loupe passes the request as one JSON string so `base64: null` survives.

The image scanner in [loupe-image-scanner.ts](../extension-loupe/src/loupe-image-scanner.ts) shares behavior with `obsidian-webp-paste`. Keep their scanner cases aligned when changing that behavior.

## Permissions

Loupe requests access to all sites and uses the `storage` permission. It fetches images without CORS and injects into the configured Tansu origin.

This personal unpacked build avoids permission prompts. The broad access lets Loupe read and script every site. Do not publish this manifest to an extension store.

A published build should request optional permissions for the configured Tansu origin and image access at runtime.

## Build and tests

Run `make loupe` to build a production extension in `dist/extension-loupe`. On macOS, the command opens Helium's extension manager when Helium is installed.

Choose **Load unpacked** in the extension manager and select `dist/extension-loupe`. Rebuild with `make loupe`, then refresh Loupe in the manager.

If Loupe is already loaded from the extensions checkout, remove that entry after confirming this build works.

Run `make test-loupe-browser` for the reader UI tests in Playwright Chromium. Run `make test-e2e-loupe` for imports through both the reader menu and keyboard command.

The integration test starts a fixture Tansu server and article server. It verifies imported Markdown, localized images, remote fallbacks, and background-tab behavior.

## Build constraints

The service worker and options page use ES modules. The on-demand content script and Tansu page script use classic IIFEs because Chrome injects them without module support.

Keep Effect out of the Tansu page script. The service worker validates its results. Keep the TypeScript adapter message type narrow when the Rust contract changes.

The `defuddle-rs` checkout owns the WebAssembly parser. Loupe reads `../defuddle-rs` by default. Set `DEFUDDLE_RS_DIR` to select another checkout.

The [WASM build script](../scripts/build-defuddle-wasm.mjs) writes bindings under `extension-loupe/.generated/`. The production build copies the optimized module into the extension directory.

The [sample fixture builder](../scripts/build-reader-sample-fixture.mjs) regenerates the tracked reader fixture from its source HTML.

See [Loupe build prerequisites](development.md#loupe) for required tools and environment variables.
