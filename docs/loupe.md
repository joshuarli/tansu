# Loupe

Loupe is a Chromium Manifest V3 reader extension. Its toolbar button opens a
reader overlay on the current page. The content script sends page HTML and URL
to the service worker, which runs the `defuddle-rs` WebAssembly parser. The
reader renders extracted HTML in a Shadow DOM and keeps it only while the page
URL is unchanged.

Readers can choose an extractor, copy HTML or Markdown with YAML frontmatter,
open Markdown in Obsidian, or send it to Tansu. The Obsidian action copies
Markdown before opening its URI. Date-only publication metadata keeps its
calendar day.

## Tansu import

The reader menu and `send-to-tansu` keyboard command share the import flow. The
command defaults to Ctrl+Shift+S, or Command+Shift+S on macOS. It extracts the
active tab without opening the reader and shows progress in a toast. Loupe
stores one Tansu URL in its options page.

The service worker fetches remote article images, then sends Markdown and image
data to the Tansu tab. Tansu creates the note and localizes supported images;
see [Extension import](extension-import.md) for the protocol and failure
behavior.

## Permissions and implementation

Loupe requests access to all sites and uses the `storage` permission. It fetches
images and injects its page script into the configured Tansu origin. The broad
access makes this a personal unpacked build; do not publish its manifest to an
extension store. A published build should request optional permissions at
runtime.

The service worker and options page use ES modules. Chrome injects the
on-demand content script and Tansu page script as classic IIFEs. Keep Effect out
of the page script and keep its message type aligned with
[the Tansu import schema](../extension-loupe/src/tansu-schemas.ts).

The [WASM build script](../scripts/build-defuddle-wasm.mjs) reads `../defuddle-rs`
by default and writes generated bindings under `extension-loupe/.generated/`.
Set `DEFUDDLE_RS_DIR` to choose another checkout. The [reader fixture
builder](../scripts/build-reader-sample-fixture.mjs) regenerates the tracked
fixture from its source HTML.

Build and test commands are in [Development](development.md#loupe) and
[Testing](testing.md).
