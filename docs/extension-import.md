# Extension import

The Loupe browser extension imports a page as a note. A content script that
Loupe injects into the Tansu tab exchanges `window.postMessage` messages with the
app. The server has no import endpoint, and nothing travels in the URL.

See [Loupe](loupe.md) for the extension build, permissions, and page import flow.

Every message has `channel: "tansu"` and `version: 1`.

## Messages

Tansu to the page:

- `{ type: "import.ready" }` posts once the app can accept an import: boot has
  finished, the auth gate is not showing, and a vault is active. It posts again
  after unlock and after a vault switch, and in reply to `import.ping`.
- `{ type: "import.result", requestId, ok: true, noteId, path, imagesLocalized, imagesFailed }`
  or `{ type: "import.result", requestId, ok: false, error }`.

Loupe to Tansu:

- `{ type: "import.ping" }`
- `{ type: "import.request", requestId, title, markdown, sourceUrl, images }`.
  `markdown` is the full note, frontmatter included, and Tansu keeps it as is.
  Each remote image embed is `![alt](tansu-import-image:ID)`. `images[ID]` is
  `{ id, url, contentType, base64 }`: `id` equals the array index, `url` is the
  original absolute http(s) URL, and `base64` is `null` when Loupe could not
  fetch the image.

A message that arrives while the app is not ready is ignored, so Loupe waits for
`import.ready`. A request that fails validation gets an `ok: false` result and
causes no side effects. A message with no string `requestId` is ignored.

## Behavior

Requests run one at a time. For each image with `base64`, Tansu decodes it,
converts it to WebP at the vault's `imageWebpQuality` unless it is already WebP,
and uploads it with the vault-scoped image upload. Up to four images convert and
upload at once. Uploads finish before the note is created. A
`![alt](tansu-import-image:ID)` embed becomes the wiki-image markdown the upload
returned. When an image has no data, has an unsupported type (SVG is not
supported), or fails to convert or upload, the embed becomes `![alt](url)` and
the import continues.

Tansu then creates the note through the local-draft promotion path, with a path
derived from the title by the usual unique-path rule, and opens it as the active
tab. The title is trimmed plain text. It falls back to the source URL's host,
then to `Imported`.

A vault switch or a lock while an import runs cancels it with an `ok: false`
result.

## Limits

Tansu rejects malformed requests and enforces size, image-count, and URL bounds
defined in [Loupe's schema](../extension-loupe/src/tansu-schemas.ts) and
[Tansu's receiver](../web/ts/app/extension-import-receiver.ts).

## Security model

Tansu accepts only messages where `event.source === window` and
`event.origin === window.location.origin`, and posts replies to its own origin
only. Any script in the Tansu page can send such a message, so the receiver
treats the payload as hostile: it validates the shape narrowly, caps sizes, and
treats `markdown` only as Markdown source and `title` only as plain text. It
never renders or executes payload content. Notes it creates go through the same
authenticated, CSRF-protected writes as any other note.
