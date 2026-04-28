export type BlockKind =
  | "blank"
  | "paragraph"
  | "heading"
  | "list"
  | "blockquote"
  | "code"
  | "table"
  | "hr"
  | "other";

export type MarkdownExtension = {
  // Inline render: called at each character the core doesn't claim.
  // Return { html, consumed } to take ownership, or null to fall through.
  renderInline?: (text: string, offset: number) => { html: string; consumed: number } | null;

  // Blockquote render: intercept `>` blocks (e.g. callouts).
  // renderLines renders an array of stripped blockquote lines using the same extensions.
  // Return an HTML string to override, or null for default <blockquote>.
  renderBlockquote?: (lines: string[], renderLines: (lines: string[]) => string) => string | null;

  // Inline serialize: called for each inline element during DOM→markdown.
  // Return markdown or null to fall through to core handling.
  serializeInline?: (el: HTMLElement) => string | null;

  // Block serialize: called for each block element during DOM→markdown.
  // serializeChildren serializes the element's block children using the same extensions.
  // Return { md, kind } or null to fall through to core handling.
  serializeBlock?: (
    el: HTMLElement,
    serializeChildren: (el: HTMLElement) => string,
  ) => { md: string; kind: BlockKind } | null;

  // Declare additional block-level elements (affects blank-line separation between blocks).
  isBlock?: (el: HTMLElement) => boolean;
};
