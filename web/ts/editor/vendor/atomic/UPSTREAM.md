# Atomic Editor

Upstream: https://github.com/kenforthewin/atomic-editor
Commit: `b6ed65f01bde4510031bc7a495520bc1a7688c66` (0.6.2)
License: MIT, retained in `LICENSE`.

Imported from `src/`: `atomic-theme.ts`, `edit-helpers.ts`, `highlight.ts`,
`image-blocks.ts`, `inline-preview.ts`, `read-only.ts`, `table-widget.ts`,
`tree-progress.ts`, and `wiki-links.ts`; also
`src/styles/inline-preview.css`. `AtomicCodeMirrorEditor.tsx` and
`code-languages.ts` are excluded. Tansu imports the factories directly and
uses `markdown({ codeLanguages: [] })`.

Local patches: `image-blocks.ts` resolves standard Markdown image URLs through
the configured vault asset resolver. `inline-preview.ts` checks the read-only
facet before a task checkbox can dispatch a source edit and maps existing
whole-document decorations across syntax-safe edits in plain paragraphs and caches the paragraph-gap line scan per document and syntax tree.
`table-widget.ts` resolves the edited cell's current source span and replaces
only that span. `wiki-links.ts` skips `[[...]]` inside `![[...]]` image syntax.
The included source files also use explicit type assertions and overrides
needed by Tansu's stricter TypeScript options. `atomic-theme.ts` tags `processingInstruction` tokens with the `tansu-syntax-mark` class
for the active-line fade. Tansu rejects every unapproved
document-changing transaction while read-only.

To update, check out the recorded commit, compare each imported path, copy the
closure and license, reapply the read-only, table-span, and wiki-image patches,
and run the editor tests and fixture harness.
